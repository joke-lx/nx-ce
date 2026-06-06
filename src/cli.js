/**
 * CLI — 子命令路由器
 *
 * 模式：nx-sx/src/cli.js
 * 路由到 query | serve | status | help
 */

import { existsSync } from 'node:fs';
import { runQuery } from './query.js';
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
  const cmd = argv[0];          // 第一个参数为子命令
  const rest = argv.slice(1);

  // 解析 --key=value 或 --key value 选项
  // positional 只收集非 -- 开头的参数
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        // --key=value 格式
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) {
        // --key 后面没有值，或下一个参数也是 flag → boolean flag
        flags[arg.slice(2)] = true;
      } else {
        // --key value 格式（下一个参数作为值）
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
 * 根据子命令分发到对应的处理函数。
 */
export async function runCli() {
  const { cmd, flags, args } = parseArgs();

  switch (cmd) {
    case 'query': {
      // 冷启动查询
      const prompt = args[0] || flags.prompt;
      if (!prompt) {
        throw new Error('用法: nx-ce query <prompt> [--model ...] [--claude-path ...]');
      }

      const result = await runQuery({
        prompt,
        model: flags.model,
        cwd: flags.cwd || process.cwd(),
        claudePath: resolveClaudePath(flags['claude-path']),
        systemPrompt: flags['system-prompt'],
        persistSession: flags['no-persist'] ? false : undefined,
        resumeSessionId: flags.resume,
        skills: parseSkills(flags.skill),
        env: flags.env ? parseEnvString(flags.env) : undefined,
      });

      // 默认只返回 text + sessionId，加 --include-metadata 才返回 metadata
      if (flags['include-metadata']) {
        return result;
      }
      return { text: result.text, sessionId: result.sessionId };
    }

    case 'serve': {
      // 持久化服务模式
      const name = flags.name || 'default';

      const result = await startServe({
        name,
        claudePath: resolveClaudePath(flags['claude-path']),
        model: flags.model,
        cwd: flags.cwd || process.cwd(),
        env: flags.env ? parseEnvString(flags.env) : undefined,
      });

      return result;
    }

    case 'status': {
      // 查询实例状态
      const name = flags.name;
      if (name) {
        return readState(name); // 查询指定实例
      }
      return listStates();      // 列出所有实例
    }

    case 'help':
    default:
      // 显示帮助信息
      console.log(`
	nx-ce — Claude Engine

用法:
  nx-ce query <prompt>            一次性冷启动查询
    --model <id>                  模型覆盖
    --claude-path <path>          Claude CLI 路径
    --system-prompt <text>        系统提示词覆盖
    --resume <sessionId>          续接之前的会话（长对话）
    --skill <name>[,<name>...]    加载指定 Skill（逗号分隔，传 "all" 加载全部）
    --include-metadata            输出中附带 skills/tools/slash_commands 列表
    --no-persist                  不持久化会话
    --env "KEY=value,KEY2=val"    额外环境变量

  nx-ce serve                     持久化管理器进程（stdin/stdout）
    --name <name>                 实例名称（默认: "default"）
    --model <id>                  模型覆盖
    --claude-path <path>          Claude CLI 路径
    --env "KEY=value,..."         额外环境变量

  nx-ce status [--name <name>]   查看实例状态

  nx-ce help                      显示此帮助
`);
      return null;
  }
}

/**
 * 解析 Claude CLI 路径。
 * 优先使用命令行参数，然后检查环境变量。
 *
 * @param {string|undefined} flag - 命令行传入的路径
 * @returns {string|undefined} 解析后的路径，未找到则返回 undefined（由 SDK 自动检测）
 */
function resolveClaudePath(flag) {
  if (flag) return flag;
  // 常见位置
  const candidates = [
    process.env.CLAUDE_PATH,
    process.env.CLAUDE_CLI_PATH,
    // Windows: npx、npm 全局或用户本地安装
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  // 未找到，让 SDK 自动检测
  return undefined;
}

/**
 * 解析环境变量字符串为对象。
 * 格式: "KEY=value,KEY2=val2"
 *
 * @param {string} str - 逗号分隔的 KEY=value 对
 * @returns {object}
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

/**
 * 解析 --skill 参数。
 * 逗号分隔的列表 → 数组；"all" → "all"（由 SDK 处理）。
 */
function parseSkills(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'all' || value === 'ALL') return 'all';
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}
