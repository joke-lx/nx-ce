/**
 * session/state — 会话数据模型
 *
 * 纯数据层：生命周期枚举 + 默认状态工厂，无 IO 副作用。
 */

/**
 * 会话生命周期状态枚举。
 * 参考 happy 的 lifecycleState: "running" | "stopped" | "crashed"
 */
export const LifecycleState = Object.freeze({
  RUNNING: 'running',
  STOPPED: 'stopped',
  CRASHED: 'crashed',
  RESUMING: 'resuming',
});

/**
 * 创建一个新的状态对象（含默认值）。
 *
 * @param {string} name - 实例名称
 * @param {object} [overrides] - 覆盖字段
 * @returns {object}
 */
export function createState(name, overrides = {}) {
  return {
    name,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionId: null,
    model: 'claude-sonnet-4-6',
    host: '',
    machineId: '',
    claudeVersion: '',
    lifecycleState: LifecycleState.RUNNING,
    lifecycleStateSince: Date.now(),
    startedBy: 'serve',
    port: null,
    usage: {
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 0,
      contextWindow: 200000,
      contextTokens: 0,
    },
    ...overrides,
  };
}
