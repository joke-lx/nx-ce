/**
 * cli/commands — CLI 子命令实现
 *
 * v0.2 起仅 serve 模式：所有调用统一收敛到 WebSocket 服务，
 * 元数据通过 getSkills 消息获取。
 *
 * 路由: serve | status | help
 */

import { startServe } from '../server.js';
import { readState, listStates } from '../session/store.js';
import { parseArgs } from './parser.js';
import { resolveClaudePath, parseEnvString } from './resolve.js';

/**
 * 运行 CLI 入口。
 */
export async function runCli() {
  const { cmd, flags } = parseArgs();

  switch (cmd) {
    case 'serve': {
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

