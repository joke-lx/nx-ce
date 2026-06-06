/**
 * 服务端 — 持久化管理器进程
 *
 * 通过 stdin/stdout 运行，使用 4B+JSON 格式协议。
 * 每个实例维护一个持久化的 agentQuery() 会话。
 *
 * 协议消息（与 native_host/protocol.go 线缆格式一致）：
 *   → { "id":"...", "type":"query", "prompt":"..." }
 *   ← { "id":"...", "type":"text", "content":"..." }
 *   ← { "id":"...", "type":"done", "sessionId":"..." }
 *   ← { "id":"...", "type":"error", "content":"..." }
 *   → { "type":"ping" }
 *   ← { "type":"pong", "sessionId":"..." }
 */

import { query as agentQuery } from '@anthropic-ai/claude-agent-sdk';
import { readMessage, writeMessage } from './protocol.js';
import { readState, writeState, deleteState } from './session-store.js';

/**
 * 启动一个持久化服务会话。
 * 从 stdin 读取，向 stdout 写入，持续运行直到 stdin 关闭。
 */
export async function startServe(options) {
  const { name, claudePath, model, cwd, env } = options;

  // 检查是否有可恢复的会话状态
  const existingState = readState(name);

  // 组装 SDK 选项
  const sdkOptions = {
    cwd: cwd || process.cwd(),
    model: model || 'claude-sonnet-4-6',
    pathToClaudeCodeExecutable: claudePath,
    permissionMode: 'bypassPermissions', // 跳过权限确认
    allowDangerouslySkipPermissions: true,
    env: { ...process.env, ...env },
  };

  // 如果存在之前的会话 ID，恢复会话
  if (existingState?.sessionId) {
    sdkOptions.resume = existingState.sessionId;
  }

  // 简单的异步消息队列（供 SDK 侧消费方拉取）
  const pendingMessages = [];  // 待发送消息缓冲区
  let resolveNext = null;     // 下一轮迭代的 resolve 函数
  let turnActive = false;     // 当前轮次是否活跃
  let channelClosed = false;  // 通道是否已关闭

  // 消息通道：作为异步迭代器供 SDK 消费
  const messageChannel = {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          // 有缓冲消息且当前轮次空闲 → 立即返回
          while (pendingMessages.length > 0 && !turnActive) {
            turnActive = true;
            return Promise.resolve({
              value: pendingMessages.shift(),
              done: false,
            });
          }
          // 通道已关闭 → 结束迭代
          if (channelClosed) return Promise.resolve({ done: true, value: null });
          // 否则等待消息入队或轮次完成
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
      };
    },
  };

  /**
   * 将 SDK 用户消息入队。
   * 优先直接交付给等待中的迭代器，否则放入缓冲区（最多 8 条）。
   */
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

  /** 当前轮次完成：重置状态并触发下一轮读取 */
  function onTurnComplete() {
    turnActive = false;
    const r = resolveNext;
    resolveNext = null;
    if (r) r({ done: true, value: null });
  }

  // 启动持久化查询
  const response = agentQuery({
    prompt: messageChannel,
    options: sdkOptions,
  });

  let currentSessionId = existingState?.sessionId || null;

  // 持久化初始状态
  writeState(name, {
    name,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    sessionId: currentSessionId,
    model: sdkOptions.model,
  });

  // 后台任务：消费 SDK 输出并写入 stdout
  const consumerPromise = (async () => {
    try {
      for await (const message of response) {
        // 捕获初始化消息中的会话 ID，更新持久化状态
        if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
          currentSessionId = message.session_id;
          writeState(name, {
            name,
            pid: process.pid,
            startedAt: new Date().toISOString(),
            sessionId: currentSessionId,
            model: sdkOptions.model,
          });
        }

        // 助手消息 → 区分为 text / tool_use / thinking 块写入 stdout
        if (message.type === 'assistant' && message.message?.content) {
          const content = message.message.content;
          if (typeof content === 'string') {
            writeMessage(process.stdout, { type: 'text', content });
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') {
                writeMessage(process.stdout, { type: 'text', content: block.text });
              } else if (block.type === 'tool_use') {
                writeMessage(process.stdout, {
                  type: 'tool_use',
                  name: block.name,
                  input: block.input,
                  id: block.id,
                });
              } else if (block.type === 'thinking') {
                writeMessage(process.stdout, { type: 'thinking', content: block.thinking });
              }
            }
          }
        }

        // result 消息表示当前轮次完成
        if (message.type === 'result') {
          writeMessage(process.stdout, { type: 'done', sessionId: currentSessionId });
          onTurnComplete();
        }
      }
    } catch (err) {
      if (err?.code === 'ABORT_ERR') return; // 主动中断，非错误
      writeMessage(process.stdout, {
        type: 'error',
        content: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  // 主循环：从 stdin 读取协议消息，转发给 SDK
  try {
    while (true) {
      let req;
      try {
        req = await readMessage(process.stdin);
      } catch (err) {
        if (err?.message?.startsWith?.('message too large')) {
          writeMessage(process.stdout, { type: 'error', content: 'message too large' });
          continue;
        }
        break; // EOF 或解析错误 → 关闭
      }

      if (!req) break; // 正常 EOF

      // 根据消息类型路由
      if (req.type === 'query' && req.prompt) {
        // 构建 SDK 用户消息
        const sdkMessage = {
          type: 'user',
          message: {
            role: 'user',
            content: req.prompt,
          },
          session_id: currentSessionId || '',
          uuid: `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
        };

        enqueueMessage(sdkMessage);
      } else if (req.type === 'ping') {
        // ping/pong 心跳
        writeMessage(process.stdout, { type: 'pong', sessionId: currentSessionId });
      }
    }
  } finally {
    // 清理：关闭通道、中断查询、等待消费完成、删除状态文件
    channelClosed = true;
    if (resolveNext) {
      resolveNext({ done: true, value: null });
    }
    try {
      await response.interrupt();
    } catch { /* 忽略中断错误 */ }
    await consumerPromise;
    deleteState(name);
  }
}
