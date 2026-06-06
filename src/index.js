/**
 * nx-ce — 公开 API 入口
 *
 * 用法:
 *   import { startServe, readState } from 'nx-ce';
 *   await startServe({ name: 'main', port: 3100 });
 *
 * v0.2 起：nx-ce 仅提供 WebSocket serve 模式，不再有冷启动 query。
 * 所有调用方（CLI / Chrome 扩展 / native_host）都通过 WS 协议与 serve 通信。
 */

export { startServe } from './serve.js';
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
