/**
 * 会话存储 — 磁盘上的持久化状态
 *
 * 模式：nx-sx 的 writeState/readState。
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
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
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
 *
 * @returns {Array<{ name: string, state: object }>}
 */
export function listStates() {
  ensureDir();
  const files = readdirSync(STATE_DIR);
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const name = f.slice(0, -5); // 去掉 .json 后缀
      const state = readState(name);
      return { name, state };
    });
}

/**
 * 将实例名称清理为安全的文件名。
 * 移除非字母数字的字符，替换为下划线。
 *
 * @param {string} name - 原始实例名称
 * @returns {string} 安全的文件名（带 .json 后缀）
 */
function sanitize(name) {
  return `${String(name).replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
}
