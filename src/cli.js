/**
 * CLI — 子命令路由器（v0.2 起仅 serve 模式）
 *
 * 历史:
 *   - 旧版有 query（冷启动）/ skills（独立拉元数据）子命令
 *   - v0.2 起所有调用统一收敛到 serve：所有元数据通过 getSkills 消息获取
 *
 * 路由: serve | status | help
 */

import { existsSync } from 'node:fs';
import { startServe } from './serve.js';
import { readState, listStates } from './session-store.js';

/**
 * 解析命令行参数。
 * 支持 --key=value 和 --key value 两种格式。
 *
 * @param {string[]} argv - 命令行参数数组（默认 process.argv.slice(2)）
 * @returns {{ cmd: string, flags: object, args: string[] }}
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const rest = argv.slice(1);

  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) {
        flags[arg.slice(2)] = true;
      } else {
        flags[arg.slice(2)] = rest[++i] ?? true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { cmd, flags, args: positional };
}

/**
 * 运行 CLI 入口。
 */
export async function runCli() {
  const { cmd, flags } = parseArgs();

  switch (cmd) {
    case 'serve': {
      // WebSocket 持久化服务模式（唯一数据通路）
      const name = flags.name || 'default';
      const result = await startServe({
        name,
        claudePath: resolveClaudePath(flags['claude-path']),
        model: flags.model,
        cwd: flags.cwd || process.cwd(),
        env: flags.env ? parseEnvString(flags.env) : undefined,
        port: flags.port ? parseInt(flags.port, 10) : undefined,
      });
      return result;
    }

    case 'status': {
      const name = flags.name;
      if (name) {
        return readState(name);
      }
      return listStates();
    }

    case 'help':
    case '--help':
    case '-h':
    default:
      console.log(`
	nx-ce — Claude Engine (v0.2: serve-only)

用法:
  nx-ce serve                     WebSocket 持久化服务器（唯一入口）
    --name <name>                 实例名称（默认: "default"）
    --port <port>                 WebSocket 端口（默认: 43720）
    --model <id>                  模型覆盖
    --claude-path <path>          Claude CLI 路径
    --cwd <path>                  默认工作目录
    --env "KEY=value,..."         额外环境变量

  nx-ce status [--name <name>]   查看实例状态

  nx-ce help                      显示此帮助

协议（ws://127.0.0.1:3100）:
  C→S: query / getSkills / getStatus / listSessions / closeSession / ping
  S→C: connected / init / turn_start / text / thinking / tool_use / done /
       error / pong / skills / status / session_list / session_closed
`);
      return null;
  }
}

/**
 * 解析 Claude CLI 路径。
 */
function resolveClaudePath(flag) {
  if (flag) return flag;
  const candidates = [process.env.CLAUDE_PATH, process.env.CLAUDE_CLI_PATH];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return undefined;
}

/**
 * 解析环境变量字符串 "KEY=val,KEY2=val2"
 */
function parseEnvString(str) {
  const result = {};
  for (const pair of str.split(',')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx !== -1) {
      result[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    }
  }
  return result;
}
