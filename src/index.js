/**
 * nx-ce — 公开 API 入口
 *
 * 用法:
 *   import { runQuery } from 'nx-ce';
 *   const { text, sessionId } = await runQuery({ prompt: 'hello', ... });
 */

export { runQuery } from './query.js';
export { listSkills } from './skills.js';
export {
  readState,
  writeState,
  deleteState,
  listStates,
  LifecycleState,
  createState,
} from './session-store.js';
export { readMessage, writeMessage } from './protocol.js';
export { generateId, MonotonicClock, getMachineId, formatBytes } from './util.js';
