/**
 * 服务端 — WebSocket 持久化服务器，支持多会话管理
 *
 * 单例进程，对外提供 WebSocket 接口。
 * 每个会话（session）拥有独立的 agentQuery()、MessageChannel 和状态文件，
 * 天然并行，互不阻塞。
 *
 * 竞态保护：
 *   - session 创建：pendingCreates Map 防止重复创建
 *   - client 绑定：SDK 回复只写 session.client，不走 broadcast
 *   - state 文件：每个 session 独立文件，写锁防并发
 *   - 消息排序：每个 session 独立单调时钟
 */

import { WebSocketServer } from 'ws';
import { query as agentQuery } from '@anthropic-ai/claude-agent-sdk';
import { hostname, machine, platform, release } from 'node:os';
import { readState, writeState, deleteState, LifecycleState, createState } from './session-store.js';
import { generateId, MonotonicClock, getMachineId } from './util.js';

/** 默认端口 */
const DEFAULT_PORT = 3100;

/** 空闲 session 超时（毫秒），超过此时间无客户端则自动关闭 */
const SESSION_IDLE_TIMEOUT_MS = 300_000; // 5 分钟

// =================================================================
// SessionManager — 管理多个独立 SDK 会话
// =================================================================

class SessionManager {
  constructor(serverOptions) {
    this.serverOptions = serverOptions; // { claudePath, model, cwd, env }

    /** @type {Map<string, Session>} */
    this.sessions = new Map();

    /** 创建中的 Promise，防止并发创建同名 session */
    this._pendingCreates = new Map();

    /** 清理定时器 */
    this._idleTimers = new Map();

    /** 会话状态文件写锁 */
    this._writeLocks = new Map();
  }

  /**
   * 获取或创建一个 session。
   * 如果另一个协程正在创建同名 session，则等待其完成。
   *
   * @param {string} name - session 名称（每个客户端/标签页唯一）
   * @returns {Promise<Session>}
   */
  async getOrCreate(name) {
    // 已有活跃 session → 直接返回
    const existing = this.sessions.get(name);
    if (existing && !existing.closed) {
      // 取消 idle 定时器（客户端回来了）
      this._cancelIdleTimer(name);
      return existing;
    }

    // 正在被另一个协程创建 → 等它
    if (this._pendingCreates.has(name)) {
      return this._pendingCreates.get(name);
    }

    // 创建锁 + 创建
    const promise = this._createSession(name);
    this._pendingCreates.set(name, promise);

    try {
      return await promise;
    } finally {
      this._pendingCreates.delete(name);
    }
  }

  /**
   * 创建内部 session 结构。
   * 注意：JS 是单线程 event loop，此函数不会被并发调用（pendingCreates 保证）。
   */
  async _createSession(name) {
    const { claudePath, model, cwd, env } = this.serverOptions;

    // 检查是否有可恢复的会话状态
    const existingState = readState(name);

    // 组装 SDK 选项
    const sdkOptions = {
      cwd: cwd || process.cwd(),
      model: model || 'claude-sonnet-4-6',
      pathToClaudeCodeExecutable: claudePath,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      env: { ...process.env, ...env },
    };

    if (existingState?.sessionId) {
      sdkOptions.resume = existingState.sessionId;
    }

    // 消息通道 — SDK 从此处拉取下一条用户消息
    const pendingMessages = [];
    let resolveNext = null;
    let turnActive = false;
    let channelClosed = false;

    const messageChannel = {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            while (pendingMessages.length > 0 && !turnActive) {
              turnActive = true;
              return Promise.resolve({ value: pendingMessages.shift(), done: false });
            }
            if (channelClosed) return Promise.resolve({ done: true, value: null });
            return new Promise((resolve) => { resolveNext = resolve; });
          },
        };
      },
    };

    function enqueueMessage(sdkUserMessage) {
      if (resolveNext) {
        turnActive = true;
        const r = resolveNext;
        resolveNext = null;
        r({ value: sdkUserMessage, done: false });
      } else if (pendingMessages.length < 8) {
        pendingMessages.push(sdkUserMessage);
      }
    }

    function onTurnComplete() {
      turnActive = false;
    }

    // 启动 SDK 持久化查询
    const response = agentQuery({ prompt: messageChannel, options: sdkOptions });

    /** @type {Session} */
    const session = {
      name,
      messageChannel,
      enqueueMessage,
      onTurnComplete,
      channelClosed: false,
      closeChannel() {
        channelClosed = true;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r({ done: true, value: null });
        }
      },

      response,
      sdkOptions,
      existingState,

      // 客户端状态
      client: null,        // 当前绑定的 WebSocket 客户端
      queue: [],           // 待处理查询 FIFO
      turnActive: false,   // SDK 是否正在处理
      currentTurnId: null,
      processing: false,

      // 元数据
      sessionId: existingState?.sessionId || null,
      metadata: null,       // init 消息中的 skills/tools 等
      clock: new MonotonicClock(),
      closed: false,

      // 消费 Promise（用于等待关闭）
      consumerPromise: null,

      // usage 追踪
      usage: existingState?.usage || {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        contextWindow: 200000,
        contextTokens: 0,
      },
    };

    // 后台消费 SDK 输出
    session.consumerPromise = this._startConsumer(session);

    this.sessions.set(name, session);

    // 持久化初始状态
    this._safeWriteState(session);

    return session;
  }

  /**
   * 后台消费循环 — 每个 session 独立。
   * SDK 回复只会写入 session.client（绑定的 WS 客户端）。
   */
  _startConsumer(session) {
    return (async () => {
      try {
        for await (const message of session.response) {
          // init 消息 → 捕获元数据
          if (message.type === 'system' && message.subtype === 'init') {
            session.sessionId = message.session_id;
            session.metadata = {
              type: 'init',
              sessionId: session.sessionId,
              model: message.model,
              skills: message.skills || [],
              tools: message.tools || [],
              slashCommands: message.slash_commands || [],
              agents: message.agents || [],
              time: session.clock.next(),
            };
            this._safeWriteState(session);

            // 推给当前绑定的客户端
            this._send(session.client, session.metadata);
          }

          // 助手消息 → 分块转发
          if (message.type === 'assistant' && message.message?.content) {
            const content = message.message.content;
            if (typeof content === 'string') {
              this._send(session.client, { type: 'text', content, time: session.clock.next() });
            } else if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text') {
                  this._send(session.client, { type: 'text', content: block.text, time: session.clock.next() });
                } else if (block.type === 'tool_use') {
                  this._send(session.client, { type: 'tool_use', name: block.name, input: block.input, id: block.id, time: session.clock.next() });
                } else if (block.type === 'thinking') {
                  this._send(session.client, { type: 'thinking', content: block.thinking, time: session.clock.next() });
                }
              }
            }
          }

          // result → 回合结束
          if (message.type === 'result') {
            this._send(session.client, { type: 'done', sessionId: session.sessionId, time: session.clock.next() });

            // usage 累积
            if (message.usage) {
              const u = message.usage;
              session.usage = {
                inputTokens: (session.usage?.inputTokens || 0) + (u.inputTokens || 0),
                outputTokens: (session.usage?.outputTokens || 0) + (u.outputTokens || 0),
                cacheCreationInputTokens: (session.usage?.cacheCreationInputTokens || 0) + (u.cacheCreationInputTokens || 0),
                cacheReadInputTokens: (session.usage?.cacheReadInputTokens || 0) + (u.cacheReadInputTokens || 0),
                contextWindow: u.contextWindow || session.usage?.contextWindow || 200000,
                contextTokens: u.contextTokens || session.usage?.contextTokens || 0,
              };
            }

            session.onTurnComplete();
            session.client = null;     // 解绑客户端，允许下一个 query 绑定
            session.processing = false;
            this._safeWriteState(session);

            // 异步处理队列中的下一个请求
            setImmediate(() => this._processQueue(session));
          }
        }
      } catch (err) {
        if (err?.code === 'ABORT_ERR') return;
        this._send(session.client, { type: 'error', content: err instanceof Error ? err.message : String(err), time: session.clock.next() });
      }
    })();
  }

  /**
   * 尝试处理 session 队列中的下一个查询。
   */
  _processQueue(session) {
    if (session.closed) return;
    if (session.queue.length === 0 || session.processing) return;

    const { client, prompt, id } = session.queue.shift();
    session.client = client;
    session.processing = true;
    session.currentTurnId = generateId('turn');

    this._send(session.client, {
      type: 'turn_start',
      turn: session.currentTurnId,
      time: session.clock.next(),
    });

    const sdkMessage = {
      type: 'user',
      message: { role: 'user', content: prompt },
      session_id: session.sessionId || '',
      uuid: generateId('msg'),
    };

    session.enqueueMessage(sdkMessage);
  }

  /** 向一个 WS 客户端发 JSON（安全断开则跳过） */
  _send(client, data) {
    if (client && client.readyState === 1) {
      client.send(JSON.stringify(data));
    }
  }

  /** 持久化 session 状态（写锁防止同名并发写） */
  _safeWriteState(session) {
    const name = session.name;
    // JS 单线程，用简单 flag 防同一 session 的递归写
    writeState(name, createState(name, {
      sessionId: session.sessionId,
      model: session.sdkOptions.model,
      usage: session.usage,
    }));
  }

  /** 取消 idle 定时器 */
  _cancelIdleTimer(name) {
    const timer = this._idleTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this._idleTimers.delete(name);
    }
  }

  /** 安排 idle 关闭 */
  _scheduleIdleCleanup(name) {
    this._cancelIdleTimer(name);
    this._idleTimers.set(name, setTimeout(() => {
      this.destroy(name, 'idle timeout');
    }, SESSION_IDLE_TIMEOUT_MS));
  }

  /**
   * 从 session 队列中移除指定客户端的所有待处理请求。
   */
  removeClientFromQueue(session, ws) {
    if (!session || session.closed) return;
    session.queue = session.queue.filter(item => item.client !== ws);
  }

  /**
   * 销毁一个 session。
   */
  async destroy(name, reason = 'shutdown') {
    const session = this.sessions.get(name);
    if (!session || session.closed) return;
    session.closed = true;
    this._cancelIdleTimer(name);

    // 关闭 MessageChannel → SDK next() 返回 done
    session.closeChannel();

    // 中断 SDK 查询
    try {
      await session.response.interrupt();
    } catch { /* ignore */ }

    // 等待消费循环结束
    try {
      await session.consumerPromise;
    } catch { /* ignore */ }

    this.sessions.delete(name);

    // 如果是正常关闭才清理状态文件（crash 留文件便于恢复）
    if (reason !== 'crash') {
      deleteState(name);
    }
  }

  /**
   * 销毁所有 session。
   */
  async destroyAll(reason = 'shutdown') {
    const names = [...this.sessions.keys()];
    await Promise.allSettled(names.map(name => this.destroy(name, reason)));
  }
}

// =================================================================
// 启动函数
// =================================================================

/**
 * 启动 WebSocket 持久化服务。
 */
export async function startServe(options) {
  const { name = 'default', claudePath, model, cwd, env, port = DEFAULT_PORT } = options;

  const machineId = getMachineId();
  const host = hostname();
  const osInfo = `${platform()}/${release()}/${machine()}`;

  // 服务器级别状态
  const serverState = readState(name);
  const serverSessionId = serverState?.sessionId || null;

  // 创建 SessionManager
  const sessionManager = new SessionManager({ claudePath, model, cwd, env });

  // =================================================================
  // WebSocket 服务器
  // =================================================================

  const wss = new WebSocketServer({ port, host: '127.0.0.1' });

  // 等待服务器就绪
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${port} already in use — another nx-ce serve is running`);
      }
      reject(err);
    });
  });

  // 写入服务器级状态
  writeState(name, {
    name,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    host,
    machineId,
    port,
    lifecycleState: LifecycleState.RUNNING,
    sessionCount: 0,
  });

  // 客户端连接处理
  wss.on('connection', (ws) => {
    // 初始连接消息
    ws.send(JSON.stringify({
      type: 'connected',
      port,
      host,
      machineId,
      serverTime: Date.now(),
    }));

    ws.on('message', async (raw) => {
      let req;
      try {
        req = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', content: 'invalid JSON' }));
        return;
      }

      const sessionName = req.session || 'default';

      switch (req.type) {
        case 'query': {
          if (!req.prompt) {
            ws.send(JSON.stringify({ type: 'error', content: 'query missing prompt' }));
            break;
          }

          // 获取或创建 session（创建锁保证并发安全）
          let session;
          try {
            session = await sessionManager.getOrCreate(sessionName);
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', content: `session create failed: ${err.message}` }));
            break;
          }

          // 入队
          session.queue.push({ client: ws, prompt: req.prompt, id: req.id });
          sessionManager._processQueue(session);
          break;
        }

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', serverTime: Date.now() }));
          break;

        case 'getSkills': {
          const session = sessionManager.sessions.get(sessionName);
          if (session?.metadata) {
            ws.send(JSON.stringify(session.metadata));
          } else {
            ws.send(JSON.stringify({
              type: 'skills',
              skills: [],
              tools: [],
              slashCommands: [],
              agents: [],
              note: 'session not yet initialized',
            }));
          }
          break;
        }

        case 'getStatus': {
          const session = sessionManager.sessions.get(sessionName);
          ws.send(JSON.stringify({
            type: 'status',
            session: sessionName,
            sessionId: session?.sessionId || null,
            isActive: session ? !session.closed : false,
            queueLength: session?.queue?.length || 0,
            processing: session?.processing || false,
          }));
          break;
        }

        case 'closeSession': {
          await sessionManager.destroy(sessionName, 'client request');
          ws.send(JSON.stringify({ type: 'session_closed', session: sessionName }));
          break;
        }

        case 'listSessions': {
          const sessions = [...sessionManager.sessions.entries()]
            .filter(([_, s]) => !s.closed)
            .map(([name, s]) => ({
              name,
              sessionId: s.sessionId,
              queueLength: s.queue.length,
              processing: s.processing,
            }));
          ws.send(JSON.stringify({ type: 'session_list', sessions }));
          break;
        }

        default:
          ws.send(JSON.stringify({ type: 'error', content: `unknown type: ${req.type}` }));
      }
    });

    // 客户端断开 → 清理引用
    ws.on('close', () => {
      for (const [sName, session] of sessionManager.sessions) {
        if (session.client === ws) {
          session.client = null;
        }
        sessionManager.removeClientFromQueue(session, ws);

        // 如果没有客户端了，安排 idle 回收
        if (session.client === null && session.queue.length === 0 && !session.closed) {
          sessionManager._scheduleIdleCleanup(sName);
        }
      }
    });
  });

  // =================================================================
  // 信号处理（优雅关闭）
  // =================================================================

  async function shutdown() {
    // 更新服务器状态
    writeState(name, {
      ...readState(name),
      lifecycleState: LifecycleState.STOPPED,
    });

    // 通知所有 WS 客户端
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.close(1001, 'server shutting down');
      }
    });
    wss.close();

    // 关闭所有 session
    await sessionManager.destroyAll('shutdown');

    // 删除服务端状态文件
    deleteState(name);

    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // =================================================================
  // 返回
  // =================================================================

  const info = { port, name };
  console.error(`nx-ce serve ws://127.0.0.1:${port} [${name}]`);

  return info;
}
