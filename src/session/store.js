/**
 * session/store — 会话状态的磁盘持久化
 *
 * 参考 happy 的 sessions.json 设计：
 *   - 每个命名实例存储完整元数据
 *   - lifecycleState 追踪会话生命周期
 *   - machineId/host 标识运行环境
 *   - usage 追踪 token 消耗
 *
 * 目录：$HOME/.nx-ce/instances/{name}.json
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 状态文件存储目录 */
const STATE_DIR = join(homedir(), '.nx-ce', 'instances');

/** 确保存储目录存在 */
function ensureDir() {
  mkdirSync(STATE_DIR, { recursive: true });
}

/**
 * 读取指定实例的持久化状态。
 *
 * @param {string} name - 实例名称
 * @returns {object|null} 状态对象，不存在则返回 null
 */
export function readState(name) {
  ensureDir();
  const path = join(STATE_DIR, sanitize(name));
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 写入指定实例的持久化状态。
 *
 * @param {string} name - 实例名称
 * @param {object} state - 要持久化的状态对象
 */
export function writeState(name, state) {
  ensureDir();
  const path = join(STATE_DIR, sanitize(name));
  const enriched = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(enriched, null, 2), 'utf8');
}

/**
 * 删除指定实例的持久化状态。
 *
 * @param {string} name - 实例名称
 */
export function deleteState(name) {
  const path = join(STATE_DIR, sanitize(name));
  try {
    rmSync(path, { force: true });
  } catch {
    // 文件不存在则静默忽略
  }
}

/**
 * 列出所有已知的实例。
 * state.name 可能为 "name:cwd" 格式，自动拆分为 name 和 cwd 字段。
 *
 * @returns {Array<{ name: string, cwd: string|null, state: object }>}
 */
export function listStates() {
  ensureDir();
  const files = readdirSync(STATE_DIR);
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const stem = f.slice(0, -5);
      const state = readState(stem);
      if (!state) return null;
      const key = state.name || stem;
      const idx = key.indexOf(':');
      return {
        name: idx === -1 ? key : key.slice(0, idx),
        cwd: idx === -1 ? (state.cwd ?? null) : key.slice(idx + 1),
        state,
      };
    })
    .filter(Boolean);
}

/**
 * 将实例名称清理为安全的文件名。
 * 保留字母、数字、点、下划线、连字符、冒号（转为 ~）。
 * 冒号转为 ~ 是为了支持 "name:cwd" 格式的内部 key。
 *
 * @param {string} name - 原始实例名称
 * @returns {string} 安全的文件名（带 .json 后缀）
 */
function sanitize(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9._~-]/g, '_').replace(/:/g, '~');
  return `${safe}.json`;
}
