/**
 * session/key — 会话 Key 工具函数
 *
 * 会话标识 = name:cwd（同一 name 不同 cwd 视为不同会话）。
 */

/**
 * 生成 session 内部标识 key = name:cwd。
 *
 * 语义：
 *   同一 name + 同一 cwd → 继续同一对话（恢复）
 *   同一 name + 不同 cwd → 全新对话（独立 agentQuery）
 *   不同 name → 全新对话（无论 cwd）
 *
 * @param {string} name - 会话窗口名称
 * @param {string} [cwd] - 工作目录
 * @returns {string} 内部 key
 */
export function sessionKey(name, cwd) {
  if (cwd) return `${name}:${cwd}`;
  return name;
}

/**
 * 从 sessionKey 中提取原始 name（用于 closeSession / 历史列表 name 恢复）。
 *
 * @param {string} key - 形如 "name:cwd" 或经 sanitize 后的 "name~cwd"
 * @returns {string} name 部分
 */
export function baseName(key) {
  // 优先找原始分隔符 ":"，再找 sanitize 后的 "~"
  let idx = key.indexOf(':');
  if (idx === -1) idx = key.indexOf('~');
  return idx === -1 ? key : key.slice(0, idx);
}
