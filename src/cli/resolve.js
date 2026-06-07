/**
 * cli/resolve — CLI 工具函数
 *
 * 环境变量解析、路径探测等无副作用的辅助函数。
 */

import { existsSync } from 'node:fs';

/**
 * 解析 Claude CLI 路径。
 * 优先取 --claude-path 标志，fallback 到环境变量。
 *
 * @param {string|undefined} flag - 命令行传入的 --claude-path 值
 * @returns {string|undefined}
 */
export function resolveClaudePath(flag) {
  if (flag) return flag;
  const candidates = [process.env.CLAUDE_PATH, process.env.CLAUDE_CLI_PATH];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return undefined;
}

/**
 * 解析环境变量字符串 "KEY=val,KEY2=val2" 为对象。
 *
 * @param {string} str - 逗号分隔的 KEY=value 对
 * @returns {Record<string, string>}
 */
export function parseEnvString(str) {
  const result = {};
  for (const pair of str.split(',')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx !== -1) {
      result[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    }
  }
  return result;
}
