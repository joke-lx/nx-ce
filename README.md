# nx-ce — Claude Engine

**nx-ce** 是一个轻量级 Node.js 适配器，封装了 `@anthropic-ai/claude-agent-sdk`。
通过长度前缀的 JSON 协议（与 Chrome Native Messaging 格式一致）在 stdin/stdout 上暴露 SDK 接口，
支持一次性冷启动查询与持久化服务两种运行模式。

**nx-ce** is a lightweight Node.js adapter for `@anthropic-ai/claude-agent-sdk`.
It exposes the SDK over stdin/stdout via a length-prefixed JSON protocol (identical to Chrome native messaging),
supporting both one-shot cold-start queries and persistent serve sessions.

---

## 项目家族 / Family

| Package | 角色 / Role |
|---------|-------------|
| **nx-ce** | Claude Engine — SDK 适配层 / SDK adapter layer |
| [nx-sx](https://github.com/jokelx/nx-sx) | Sandbox eXecution — 窗口/终端管理器 / window & terminal manager |

---

## 安装 / Install

```bash
npm install nx-ce
# 或全局安装 / or install globally
npm install -g nx-ce
```

---

## 命令行用法 / CLI Usage

### `nx-ce query <prompt>` — 一次性冷启动查询 / One-shot cold-start query

```bash
nx-ce query "解释这段代码" --model claude-sonnet-4-6
nx-ce query "Explain this code" --model claude-haiku-4-5 --no-persist
nx-ce query "继续之前的对话" --resume sess_abc123
nx-ce query "Analyze" --skill git-workflow,code-review
nx-ce query "Analyze" --skill all
```

| 选项 / Flag | 说明 / Description |
|-------------|-------------------|
| `--model <id>` | 模型 ID 覆盖（默认 `claude-sonnet-4-6`）/ Model override |
| `--claude-path <path>` | Claude CLI 可执行文件路径 / Path to Claude CLI binary |
| `--system-prompt <text>` | 系统提示词覆盖 / System prompt override |
| `--resume <sessionId>` | 续接之前的会话（长对话）/ Resume a prior session |
| `--skill <name>[,<name>...]` | 加载指定 Skill（逗号分隔，传 `all` 加载全部）/ Load specific skills |
| `--no-persist` | 不持久化会话 / Don't persist session |
| `--env "KEY=value,KEY2=val"` | 额外环境变量 / Extra environment variables |

### `nx-ce serve` — 持久化管理器进程 / Persistent manager process

```bash
nx-ce serve --name chat-tab-1
nx-ce serve --name default --model claude-sonnet-4-6
```

通过 stdin/stdout 接收 4B+JSON 协议消息，保持一个持久化的 SDK 会话。
Reads/writes 4B+JSON protocol messages over stdin/stdout, maintaining a persistent SDK session.

| 选项 / Flag | 说明 / Description |
|-------------|-------------------|
| `--name <name>` | 实例名称（默认 `"default"`）/ Instance name |
| `--model <id>` | 模型 ID 覆盖 / Model override |
| `--claude-path <path>` | Claude CLI 可执行文件路径 / Path to Claude CLI binary |
| `--env "KEY=value,..."` | 额外环境变量 / Extra environment variables |

### `nx-ce status` — 查看实例状态 / Show instance state

```bash
nx-ce status                  # 列出所有实例 / List all instances
nx-ce status --name chat-tab-1  # 查看指定实例 / Show specific instance
```

### `nx-ce help` — 显示帮助 / Show help

```bash
nx-ce help
```

---

## 协议 / Protocol

所有 IPC 使用与 Chrome Native Messaging 一致的线缆格式：

All IPC uses the same wire format as Chrome native messaging:

```
[4 bytes LE uint32 = 负载长度 / payload length][UTF-8 JSON payload]
```

### 查询（一次性）/ Query (one-shot)

```
→ { "prompt": "...", "model": "...", "systemPrompt": "..." }
← { "text": "...", "sessionId": "sess_xxx" }
```

### 服务（持久化）/ Serve (persistent)

```
→ { "id":"1", "type":"query", "prompt":"..." }
← { "id":"1", "type":"text", "content":"..." }
← { "id":"1", "type":"tool_use", "name":"readFile", "input":{...} }
← { "id":"1", "type":"thinking", "content":"..." }
← { "id":"1", "type":"done", "sessionId":"..." }

→ { "type":"ping" }
← { "type":"pong", "sessionId":"..." }
```

协议消息类型 / Message types:

| 方向 / Dir | type | 说明 / Description |
|------------|------|-------------------|
| → | `query` | 用户输入 / User input |
| ← | `text` | 文本回复 / Text response |
| ← | `tool_use` | 工具调用请求 / Tool use request |
| ← | `thinking` | 思考过程 / Model thinking |
| ← | `done` | 本轮完成，含会话 ID / Turn complete with session ID |
| ← | `error` | 错误消息 / Error message |
| → | `ping` | 心跳检测 / Heartbeat |
| ← | `pong` | 心跳回复 / Heartbeat response |

---

## 架构 / Architecture

```
Chrome Extension / 浏览器扩展
       ↕ Native Messaging (4B+JSON)
Native Host (Go)
       ↕ 4B+JSON (via executor.startProcess)
nx-ce serve (Node.js)
       ↕ @anthropic-ai/claude-agent-sdk
Claude Code CLI (子进程 / subprocess)
```

---

## 状态持久化 / State

状态持久化到 `~/.nx-ce/instances/{name}.json`。
每个命名实例存储其 PID、会话 ID 和启动时间，用于崩溃恢复和会话续接。

Persisted to `~/.nx-ce/instances/{name}.json`. Each named instance stores its PID, session ID, and start time for crash recovery and session resumption.

示例状态文件 / Example state file:

```json
{
  "name": "chat-tab-1",
  "pid": 12345,
  "startedAt": "2026-06-06T10:30:00.000Z",
  "sessionId": "sess_abc123",
  "model": "claude-sonnet-4-6"
}
```

---

## 开发 / Development

```bash
# 本地运行 / Run locally
node ./bin/nx-ce.js query "你好"

# 检查语法 / Check syntax
node -c src/*.js
```

---

## License / 许可证

MIT
