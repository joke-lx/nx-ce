/**
 * SessionManager — 管理多个独立的 SDK 会话
 *
 * 每个会话（session）拥有独立的 agentQuery()、MessageChannel 和状态文件，
 * 天然并行，互不阻塞。
 */

import { query as agentQuery } from '@anthropic-ai/claude-agent-sdk';
import { readState, writeState, deleteState } from './store.js';
import { LifecycleState, createState } from './state.js';
import { sessionKey, baseName } from './key.js';
import { generateId, MonotonicClock } from '../util.js';

/** 空闲 session 超时（毫秒），超过此时间无客户端则自动关闭 */
const SESSION_IDLE_TIMEOUT_MS = 300_000; // 5 分钟

// =================================================================
// SessionManager
// =================================================================

export class SessionManager {
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
  async getOrCreate(name, cwd, skills) {
    const key = sessionKey(name, cwd);

    // 已有活跃 session → 直接返回
    const existing = this.sessions.get(key);
    if (existing && !existing.closed) {
      this._cancelIdleTimer(key);
      // 如果已有 session 但本次显式传了 skills（不是空数组），
      // 销毁旧的（await 完成），重建带 skills 的。
      // 占位 query 不传 skills，正常 query 才传——所以用户发真实 query 时触发重建。
      if (skills !== undefined && skills !== null && Array.isArray(skills) && skills.length > 0) {
        await this.destroy(key, 'recreate with skills');
        // 销毁后必须同时清理 _pendingCreates，否则旧 promise 仍在占位，
        // 后面的创建逻辑会被跳过，返回无 skills 的旧 session。
        this._pendingCreates.delete(key);
      } else {
        return existing;
      }
    }

    // 正在被另一个协程创建 → 等它
    if (this._pendingCreates.has(key)) {
      return this._pendingCreates.get(key);
    }

    // 创建锁 + 创建
    const promise = this._createSession(name, key, cwd, skills);
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
  async _createSession(name, key, cwd, skills) {
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

    if (skills !== undefined && skills !== null) {
      // 显式传了 skills：不续接旧 session，只加载指定 skills
      sdkOptions.skills = skills;
    } else if (existingState?.sessionId) {
      // 无显式 skills（占位 query）：续接旧 session，保持上下文
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
              // === 核心元数据 ===
              model: message.model,
              cwd: session.cwd,
              // === 名称列表（SDK init 消息只给名字，description 需要 supportedCommands） ===
              skills: message.skills || [],
              tools: message.tools || [],
              slashCommands: message.slash_commands || [],
              agents: message.agents || [],
              // === 扩展字段（之前被丢弃） ===
              claudeCodeVersion: message.claude_code_version,
              permissionMode: message.permissionMode,
              apiKeySource: message.apiKeySource,
              mcpServers: message.mcp_servers || [],
              plugins: message.plugins || [],
              outputStyle: message.output_style,
              betas: message.betas || [],
              fastModeState: message.fast_mode_state,
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
   * @param {string} reason - 'shutdown' | 'client request' | 'idle timeout' | 'crash'
   * @param {object} [opts]
   * @param {boolean} [opts.keepHistory=true] - 是否保留磁盘状态（标记为 closed）
   *   仅 'shutdown' 和 'crash' 会删除；其他情况保留为历史记录
   */
  async destroy(key, reason = 'shutdown', opts = {}) {
    const { keepHistory = true } = opts;
    const session = this.sessions.get(key);
    if (!session || session.closed) return;
    session.closed = true;
    this._cancelIdleTimer(key);

    session.closeChannel();

    try { await session.response.interrupt(); } catch { /* ignore */ }
    try { await session.consumerPromise; } catch { /* ignore */ }

    this.sessions.delete(key);

    if (reason === 'shutdown' || reason === 'crash' || !keepHistory) {
      deleteState(key);
    } else {
      // 标记为 closed，保留历史供 listSessions / resume 使用
      const prev = readState(key);
      if (prev) {
        writeState(key, {
          ...prev,
          lifecycleState: LifecycleState.STOPPED,
          closedAt: new Date().toISOString(),
        });
      }
    }
  }

  /**
   * 按客户端 name 销毁匹配的所有 session（包括不同 cwd）。
   * @param {string} name - 客户端传入的 session 名称
   * @param {object} [opts] - 透传给 destroy()
   */
  async destroyByName(name, opts = {}) {
    const keys = [...this.sessions.keys()].filter(k => baseName(k) === name);
    await Promise.allSettled(keys.map(k => this.destroy(k, 'client request', opts)));
  }

  /**
   * 销毁所有 session。
   * @param {string} reason
   * @param {object} [opts]
   */
  async destroyAll(reason = 'shutdown', opts = {}) {
    const keys = [...this.sessions.keys()];
    await Promise.allSettled(keys.map(k => this.destroy(k, reason, opts)));
  }
}
