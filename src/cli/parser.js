/**
 * cli/parser — 命令行参数解析
 */

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
