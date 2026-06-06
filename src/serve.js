/**
 * 服务端 — WebSocket 持久化服务器，支持多会话管理
 *
 * 单例进程，对外提供 WebSocket 接口。
 * 每个会话（session）拥有独立的 agentQuery()、MessageChannel 和状态文件，
 * 天然并行，互不阻塞。
 *
 * 会话标识 = name:cwd（同一 name 不同 cwd 视为不同会话）。
 * 客户端可通过 query 消息的 cwd 字段指定工作目录。
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
// 工具函数
// =================================================================

/**
 * 生成 session 内部标识 key。
 * 同一 name 不同 cwd 产生不同 key，各自独立 agentQuery。
 *
 * @param {string} name - 会话名称（来自客户端）
 * @param {string} [cwd] - 工作目录
 * @returns {string} 内部 key
 */
function sessionKey(name, cwd) {
  if (cwd) return `${name}:${cwd}`;
  return name;
}

/**
 * 从 sessionKey 中提取原始 name（用于 closeSession 匹配）。
 */
function baseName(key) {
  const idx = key.indexOf(':');
  return idx === -1 ? key : key.slice(0, idx);
}

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
  }

  /**
   * 获取或创建一个 session。
   * 以 (name, cwd) 为唯一标识。
   * 如果另一个协程正在创建同 key session，则等待其完成。
   *
   * @param {string} name - 会话名称
   * @param {string} [cwd] - 工作目录（可选，默认服务器级 cwd）
   * @returns {Promise<Session>}
   */
  async getOrCreate(name, cwd) {
    const key = sessionKey(name, cwd);

    // 已有活跃 session → 直接返回
    const existing = this.sessions.get(key);
    if (existing && !existing.closed) {
      this._cancelIdleTimer(key);
      return existing;
    }

    // 正在被另一个协程创建 → 等它
    if (this._pendingCreates.has(key)) {
      return this._pendingCreates.get(key);
    }

    // 创建锁 + 创建
    const promise = this._createSession(name, key, cwd);
    this._pendingCreates.set(key, promise);

    try {
      return await promise;
    } finally {
      this._pendingCreates.delete(key);
    }
  }

  /**
   * 创建内部 session 结构。
   */
  async _createSession(name, key, cwd) {
    const { claudePath, model, env } = this.serverOptions;

    // session 用自己的 cwd（优先客户端传入，fallback 到服务器级）
    const actualCwd = cwd || this.serverOptions.cwd || process.cwd();

    // 检查是否有可恢复的会话状态（按 key 存储，实现不同目录独立状态）
    const existingState = readState(key);

    // 组装 SDK 选项
    const sdkOptions = {
      cwd: actualCwd,
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

    const session = {
      key,              // 内部标识：name:cwd
      name,             // 客户端名称
      cwd: actualCwd,   // session 自己的工作目录
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
      client: null,
      queue: [],
      currentTurnId: null,
      processing: false,

      // 元数据
      sessionId: existingState?.sessionId || null,
      metadata: null,
      clock: new MonotonicClock(),
      closed: false,

      consumerPromise: null,

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

    this.sessions.set(key, session);

    // 持久化初始状态（使用 key 做文件名，不同 cwd 独立文件）
    this._safeWriteState(session);

    return session;
  }

  /**
   * 后台消费循环 — 每个 session 独立。
   */
  _startConsumer(session) {
    return (async () => {
      try {
        for await (const message of session.response) {
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
              cwd: session.cwd,
              time: session.clock.next(),
            };
            this._safeWriteState(session);
            this._send(session.client, session.metadata);
          }

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

          if (message.type === 'result') {
            this._send(session.client, { type: 'done', sessionId: session.sessionId, time: session.clock.next() });

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
            session.client = null;
            session.processing = false;
            this._safeWriteState(session);

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

  /** 向一个 WS 客户端发 JSON */
  _send(client, data) {
    if (client && client.readyState === 1) {
      client.send(JSON.stringify(data));
    }
  }

  /** 持久化 session 状态（按 key 为文件名） */
  _safeWriteState(session) {
    writeState(session.key, createState(session.key, {
      sessionId: session.sessionId,
      model: session.sdkOptions.model,
      cwd: session.cwd,
      usage: session.usage,
    }));
  }

  _cancelIdleTimer(key) {
    const timer = this._idleTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this._idleTimers.delete(key);
    }
  }

  _scheduleIdleCleanup(key) {
    this._cancelIdleTimer(key);
    this._idleTimers.set(key, setTimeout(() => {
      this.destroy(key, 'idle timeout');
    }, SESSION_IDLE_TIMEOUT_MS));
  }

  removeClientFromQueue(session, ws) {
    if (!session || session.closed) return;
    session.queue = session.queue.filter(item => item.client !== ws);
  }

  /**
   * 销毁一个 session。
   * @param {string} key - 内部 key（name:cwd）
   */
  async destroy(key, reason = 'shutdown') {
    const session = this.sessions.get(key);
    if (!session || session.closed) return;
    session.closed = true;
    this._cancelIdleTimer(key);

    session.closeChannel();

    try { await session.response.interrupt(); } catch { /* ignore */ }
    try { await session.consumerPromise; } catch { /* ignore */ }

    this.sessions.delete(key);

    if (reason !== 'crash') {
      deleteState(key);
    }
  }

  /**
   * 按客户端 name 销毁匹配的所有 session（包括不同 cwd）。
   * @param {string} name - 客户端传入的 session 名称
   */
  async destroyByName(name) {
    const keys = [...this.sessions.keys()].filter(k => baseName(k) === name);
    await Promise.allSettled(keys.map(k => this.destroy(k, 'client request')));
  }

  /**
   * 销毁所有 session。
   */
  async destroyAll(reason = 'shutdown') {
    const keys = [...this.sessions.keys()];
    await Promise.allSettled(keys.map(k => this.destroy(k, reason)));
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

  const serverState = readState(name);
  const serverSessionId = serverState?.sessionId || null;

  // 创建 SessionManager（cwd 为服务器级默认，session 可覆盖）
  const sessionManager = new SessionManager({ claudePath, model, cwd, env });

  // =================================================================
  // WebSocket 服务器
  // =================================================================

  const wss = new WebSocketServer({ port, host: '127.0.0.1' });

  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${port} already in use — another nx-ce serve is running`);
      }
      reject(err);
    });
  });

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

          // 支持每个 query 指定自己的工作目录
          // 同一 session name + 不同 cwd = 不同 SDK 会话
          let session;
          try {
            session = await sessionManager.getOrCreate(sessionName, req.cwd);
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', content: `session create failed: ${err.message}` }));
            break;
          }

          session.queue.push({ client: ws, prompt: req.prompt, id: req.id });
          sessionManager._processQueue(session);
          break;
        }

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', serverTime: Date.now() }));
          break;

        case 'getSkills': {
          // 按 (name, cwd) 查 session
          const key = sessionKey(sessionName, req.cwd);
          const session = sessionManager.sessions.get(key);
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
          const key = sessionKey(sessionName, req.cwd);
          const session = sessionManager.sessions.get(key);
          ws.send(JSON.stringify({
            type: 'status',
            session: sessionName,
            cwd: req.cwd || cwd || process.cwd(),
            sessionId: session?.sessionId || null,
            isActive: session ? !session.closed : false,
            queueLength: session?.queue?.length || 0,
            processing: session?.processing || false,
          }));
          break;
        }

        case 'closeSession': {
          if (req.cwd) {
            // 精确关闭：name + cwd
            const key = sessionKey(sessionName, req.cwd);
            await sessionManager.destroy(key, 'client request');
            ws.send(JSON.stringify({ type: 'session_closed', session: sessionName, cwd: req.cwd }));
          } else {
            // 关闭该 name 下所有 cwd 变体
            await sessionManager.destroyByName(sessionName);
            ws.send(JSON.stringify({ type: 'session_closed', session: sessionName }));
          }
          break;
        }

        case 'listSessions': {
          const sessions = [...sessionManager.sessions.entries()]
            .filter(([_, s]) => !s.closed)
            .map(([key, s]) => ({
              name: s.name,
              key,
              cwd: s.cwd,
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
      for (const [sKey, session] of sessionManager.sessions) {
        if (session.client === ws) {
          session.client = null;
        }
        sessionManager.removeClientFromQueue(session, ws);

        if (session.client === null && session.queue.length === 0 && !session.closed) {
          sessionManager._scheduleIdleCleanup(sKey);
        }
      }
    });
  });

  // =================================================================
  // 信号处理（优雅关闭）
  // =================================================================

  async function shutdown() {
    writeState(name, {
      ...readState(name),
      lifecycleState: LifecycleState.STOPPED,
    });

    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.close(1001, 'server shutting down');
      }
    });
    wss.close();

    await sessionManager.destroyAll('shutdown');
    deleteState(name);

    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const info = { port, name };
  console.error(`nx-ce serve ws://127.0.0.1:${port} [${name}]`);

  return info;
}
