/**
 * skills — 查询 SDK 可用的 skill / tool / agent 列表
 *
 * 使用一次超轻量 agentQuery() 获取 init 元数据。
 * 不发起真正对话，不持久化 session。
 */

import { query as agentQuery } from '@anthropic-ai/claude-agent-sdk';

/**
 * 获取 SDK 可用的 skills/tools/slashCommands/agents 列表。
 *
 * @param {object} [options]
 * @param {string} [options.cwd]        - 工作目录
 * @param {string} [options.claudePath] - Claude CLI 路径
 * @param {object} [options.env]        - 额外环境变量
 * @returns {Promise<{ skills: string[], tools: string[], slashCommands: string[], agents: string[] }>}
 */
export async function listSkills(options = {}) {
  const sdkOptions = {
    cwd: options.cwd || process.cwd(),
    model: 'claude-haiku-4-5',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    env: { ...process.env, ...options.env },
  };

  if (options.claudePath) {
    sdkOptions.pathToClaudeCodeExecutable = options.claudePath;
  }

  // 用空 prompt 做一次超轻量 init
  const response = agentQuery({ prompt: ' ', options: sdkOptions });

  const result = {
    skills: [],
    tools: [],
    slashCommands: [],
    agents: [],
  };

  for await (const message of response) {
    if (message.type === 'system' && message.subtype === 'init') {
      if (Array.isArray(message.skills)) result.skills = message.skills;
      if (Array.isArray(message.tools)) result.tools = message.tools;
      if (Array.isArray(message.slash_commands)) result.slashCommands = message.slash_commands;
      if (Array.isArray(message.agents)) result.agents = message.agents;
      // init 消息后立即中断，不继续消耗资源
      await response.interrupt().catch(() => {});
      break;
    }
  }

  return result;
}
