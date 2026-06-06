/**
 * 工具函数 — 加密 ID 生成、单调时钟、机器标识
 *
 * 参考 happy 的 cuid2 + monotonic clock + machineId 设计。
 */

import { randomUUID, createHash } from 'node:crypto';
import { hostname, machine, platform, release } from 'node:os';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// =================================================================
// ID 生成
// =================================================================

/** 会话 ID 前缀 */
const SESSION_PREFIX = 'nxce';
/** 消息 / turn ID 前缀 */
const MSG_PREFIX = 'msg';

/**
 * 生成可排序的唯一 ID。
 * 格式: {prefix}_{timestamp}-{randomUUID片段}
 * 前缀保证可读性，时间戳保证近似排序，UUID 保证全局唯一。
 *
 * @param {string} prefix - ID 前缀
 * @returns {string}
 */
export function generateId(prefix = SESSION_PREFIX) {
  const ts = Date.now().toString(36);
  const rand = randomUUID().replace(/-/g, '').slice(0, 12);
  return `${prefix}_${ts}_${rand}`;
}

// =================================================================
// 单调时钟
// =================================================================

/**
 * 单调时钟 — 保证消息 time 字段严格递增。
 *
 * 参考 happy 的 AcpSessionManager.nextTime():
 *   time = max(lastTime + 1, Date.now())
 *
 * 即使是同一毫秒内的多条消息也能保持正确顺序。
 */
export class MonotonicClock {
  /** @type {number} */
  #lastTime = 0;

  /**
   * 获取下一个单调递增的时间戳（毫秒级）。
   * @returns {number}
   */
  next() {
    this.#lastTime = Math.max(this.#lastTime + 1, Date.now());
    return this.#lastTime;
  }

  /**
   * 重置时钟（会话重新初始化时使用）。
   */
  reset() {
    this.#lastTime = 0;
  }
}

// =================================================================
// 机器标识
// =================================================================

/** 持久化机器 ID 文件路径 */
const MACHINE_ID_FILE = join(homedir(), '.nx-ce', 'machine-id');

/**
 * 获取或生成持久的机器 ID。
 * 参考 happy 的 machineId: "418aa05c-377a-4577-b100-fd36ab54c641"
 *
 * 持久化到 ~/.nx-ce/machine-id，首次生成后固定不变。
 *
 * @returns {string}
 */
export function getMachineId() {
  try {
    if (existsSync(MACHINE_ID_FILE)) {
      return readFileSync(MACHINE_ID_FILE, 'utf8').trim();
    }
  } catch { /* 首次运行，文件不存在 */ }

  // 基于机器特征生成稳定 ID
  const raw = `${hostname()}-${machine()}-${platform()}-${release()}`;
  const id = createHash('sha256').update(raw).digest('hex').slice(0, 24);
  const formatted = [
    id.slice(0, 8),
    id.slice(8, 12),
    id.slice(12, 16),
    id.slice(16, 20),
    id.slice(20, 24),
  ].join('-');

  try {
    mkdirSync(join(homedir(), '.nx-ce'), { recursive: true });
    writeFileSync(MACHINE_ID_FILE, formatted, 'utf8');
  } catch { /* 持久化失败不阻塞 */ }

  return formatted;
}

// =================================================================
// 编码 / 序列化辅助
// =================================================================

/**
 * 将字节大小格式化为可读字符串。
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes === 0 || !bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
