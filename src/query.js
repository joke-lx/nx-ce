/**
 * 冷启动查询 — 对 @anthropic-ai/claude-agent-sdk 的一次性调用
 *
 * 参考 claudian 的 claudeColdStartQuery.ts（简单的非持久化路径）。
 * 不含 MessageChannel、流式消费循环或 Electron 兼容代码。
 */

import { query as agentQuery } from '@anthropic-ai/claude-agent-sdk';

/**
 * 执行一次冷启动查询并返回完整的文本结果。
 *
 * @param {object} options
 * @param {string} options.prompt          - 用户提示词
 * @param {string} [options.systemPrompt]  - 系统提示词覆盖
 * @param {string} [options.model]         - 模型 ID 覆盖
 * @param {string} options.cwd             - 工作目录
 * @param {string} options.claudePath      - Claude CLI 可执行文件路径
 * @param {object} [options.env]           - 额外的环境变量
 * @param {string[]} [options.tools]       - 工具白名单（省略则使用 SDK 默认值）
 * @param {boolean} [options.persistSession] - 是否持久化会话（默认 true）
 * @param {string} [options.resumeSessionId] - 恢复之前的会话
 * @param {AbortController} [options.signal] - 中止信号
 * @returns {Promise<{ text: string, sessionId: string | null }>}
 */
export async function runQuery(options) {
  const {
    prompt,
    systemPrompt,
    model,
    cwd,
    claudePath,
    env = {},
    tools,
    persistSession,
    resumeSessionId,
    signal,
  } = options;

  // 组装 SDK 选项
  const sdkOptions = {
    cwd: cwd || process.cwd(),
    model: model || 'claude-sonnet-4-6',
    pathToClaudeCodeExecutable: claudePath,
    permissionMode: 'bypassPermissions', // 跳过权限确认
    allowDangerouslySkipPermissions: true,
    env: {
      ...process.env,
      ...env, // 合并额外环境变量
    },
  };

  // 以下为可选参数的条件注入
  if (systemPrompt) {
    sdkOptions.systemPrompt = systemPrompt;
  }

  if (tools !== undefined) {
    sdkOptions.tools = tools;
  }

  if (persistSession === false) {
    sdkOptions.persistSession = false;
  }

  if (resumeSessionId) {
    sdkOptions.resume = resumeSessionId;
  }

  if (signal) {
    sdkOptions.abortController = signal;
  }

  // 确保总有一个 abort controller
  const abortController = signal || new AbortController();
  sdkOptions.abortController = abortController;

  // 发起 SDK 查询（返回异步迭代器）
  const response = agentQuery({ prompt, options: sdkOptions });

  let text = '';
  let sessionId = null;

  // 遍历 SDK 返回的流式消息
  for await (const message of response) {
    // 如果已中止，中断查询
    if (abortController.signal.aborted) {
      await response.interrupt();
      break;
    }

    // 从初始化消息中捕获会话 ID
    if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
      sessionId = message.session_id;
    }

    // 提取助手的文本回复内容
    if (message.type === 'assistant' && message.message?.content) {
      const content = message.message.content;
      if (typeof content === 'string') {
        text += content;
      } else if (Array.isArray(content)) {
        // 内容块数组，筛选出 text 块
        for (const block of content) {
          if (block.type === 'text') {
            text += block.text;
          }
        }
      }
    }
  }

  return { text, sessionId };
}
