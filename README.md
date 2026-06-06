# nx-ce — Claude Engine

[![npm version](https://img.shields.io/npm/v/nx-ce)](https://www.npmjs.com/package/nx-ce)
[![CI](https://github.com/joke-lx/nx-ce/actions/workflows/npm-publish.yml/badge.svg)](https://github.com/joke-lx/nx-ce/actions/workflows/npm-publish.yml)

**nx-ce** is a lightweight Node.js adapter for `@anthropic-ai/claude-agent-sdk`. It provides two modes:

- **`nx-ce query`** — one-shot cold-start queries (stateless, CLI-friendly)
- **`nx-ce serve`** — WebSocket multi-session server (persistent, concurrent clients)

**nx-ce** 是一个轻量级 Node.js 适配器，封装了 `@anthropic-ai/claude-agent-sdk`。支持两种运行模式：
一次性冷启动查询与多会话 WebSocket 持久化服务器。

---

## Family / 项目家族

| Package | Role / 角色 |
|---------|-------------|
| **nx-ce** | Claude Engine — SDK adapter layer / SDK 适配层 |
| [nx-sx](https://github.com/jokelx/nx-sx) | Sandbox eXecution — window & terminal manager / 窗口终端管理器 |

---

## Install / 安装

```bash
npm install nx-ce
# or globally
npm install -g nx-ce
```

---

## Quick Start / 快速开始

```bash
# One-shot query (stateless)
nx-ce query "用中文回答：1+1=？" --model claude-haiku-4-5

# Start WebSocket server (persistent, multi-session)
nx-ce serve --port 3100

# In another terminal, connect via WebSocket (see test/serve-test.mjs)
```

---

## `nx-ce query` — One-shot Cold-Start Query / 一次性冷启动查询

```bash
nx-ce query "解释这段代码" --model claude-sonnet-4-6
nx-ce query "继续之前的对话" --resume sess_abc123
nx-ce query "Analyze" --skill git-workflow,code-review
nx-ce query "Analyze" --skill all
```

| Flag | Description / 说明 |
|------|-------------------|
| `--model <id>` | Model override (default `claude-sonnet-4-6`) / 模型 ID |
| `--claude-path <path>` | Path to Claude CLI binary / Claude CLI 路径 |
| `--system-prompt <text>` | System prompt override / 系统提示词覆盖 |
| `--resume <sessionId>` | Resume a prior session (long conversation) / 续接会话 |
| `--skill <name>[,<name>...]` | Load specific skills (comma-separated, or `all`) / 加载 Skill |
| `--include-metadata` | Include skills/tools/slashCommands in output / 附带元数据 |
| `--no-persist` | Don't persist session / 不持久化 |
| `--env "KEY=val,KEY2=val"` | Extra environment variables / 额外环境变量 |

### JSON output

```json
// Default
{ "text": "2", "sessionId": "sess_abc" }

// With --include-metadata
{ "text": "2", "sessionId": "sess_abc", "metadata": { "skills": [...], "tools": [...], ... } }
```

---

## `nx-ce serve` — WebSocket Multi-Session Server / WebSocket 多会话服务器

**Single process. Multiple concurrent sessions. FIFO queries per session.**

单例进程。多会话隔离。每个会话独立 SDK agentQuery，互不阻塞。

```bash
nx-ce serve                     # default port 3100
nx-ce serve --port 3100
nx-ce serve --name "main" --port 3100 --cwd "D:/project"
```

| Flag | Description / 说明 |
|------|-------------------|
| `--name <name>` | Instance name (default `default`) / 实例名称 |
| `--port <port>` | WebSocket port (default `3100`) / 端口 |
| `--model <id>` | Model override / 模型 ID |
| `--claude-path <path>` | Path to Claude CLI / CLI 路径 |
| `--cwd <path>` | Working directory / 工作目录 |
| `--env "KEY=val,..."` | Extra env vars / 额外环境变量 |

> WebSocket address: `ws://127.0.0.1:3100` (localhost only)

### Singleton guarantee / 单例保证

```bash
nx-ce serve --port 3100      # first → OK
nx-ce serve --port 3100      # second → Port 3100 already in use — another nx-ce serve is running
```

---

## WebSocket Protocol / WebSocket 协议

Server: `ws://127.0.0.1:PORT`. All messages are JSON (no length prefix).

### Client → Server / 客户端发送

| type | Fields / 字段 | Description / 说明 |
|------|---------------|-------------------|
| `query` | `prompt: string`, `session?: string`, `id?: string` | Submit a query / 发起查询 |
| `ping` | — | Heartbeat / 心跳 |
| `getSkills` | `session?: string` | Fetch skills/tools/agents / 拉取元数据 |
| `getStatus` | `session?: string` | Query session status / 查询状态 |
| `closeSession` | `session: string` | Close a session / 关闭会话 |
| `listSessions` | — | List all active sessions / 列出会话 |

`session` defaults to `"default"` if omitted.

```json
→ { "type": "query",   "session": "tab-1", "prompt": "分析这个目录" }
→ { "type": "ping" }
→ { "type": "getSkills",         "session": "tab-1" }
→ { "type": "getStatus",         "session": "tab-1" }
→ { "type": "closeSession",      "session": "tab-1" }
→ { "type": "listSessions" }
```

### Server → Client / 服务端发送

**Connection / 连接建立:**

```json
← { "type": "connected", "port": 3100, "host": "MY-PC",
    "machineId": "744e51b9-ad7d-85bb-1600-bbfb", "serverTime": 1780736149028 }
```

**Session init (auto-push on first query per session) / 会话初始化（自动推送）:**

```json
← { "type": "init", "sessionId": "sess_xxx", "model": "claude-sonnet-4-6",
    "skills": ["browse", "code-review", ...],
    "tools": ["Read", "Edit", "Bash", ...],
    "slashCommands": ["code-review", "ship", ...],
    "agents": ["Explore", "code-reviewer", ...] }
```

**Query response (streamed chunks) / 查询响应（流式块）:**

```json
← { "type": "turn_start", "turn": "turn_xxx", "time": ... }
← { "type": "text",     "content": "这是一段回复...", "time": ... }
← { "type": "thinking", "content": "模型思考过程...", "time": ... }
← { "type": "tool_use", "name": "readFile", "input": {...}, "id": "toolu_xxx" }
← { "type": "done",     "sessionId": "sess_xxx", "time": ... }
```

**Other / 其他:**

```json
← { "type": "pong",          "sessionId": "sess_xxx", "serverTime": ... }
← { "type": "skills",        "skills": [...], "tools": [...], ... }
← { "type": "status",        "session": "tab-1", "sessionId": "sess_xxx", "isActive": true, "queueLength": 0, "processing": false }
← { "type": "session_list",  "sessions": [{ "name": "tab-1", ... }, ...] }
← { "type": "session_closed","session": "tab-1" }
← { "type": "error",         "content": "error message" }
```

### Full exchange example / 完整示例

```
→ { "type":"query", "session":"tab-1", "prompt":"Hello" }
← { "type":"turn_start", "turn":"turn_xxx", "time":... }
← { "type":"text",      "content":"Hello! How can I help you today?" }
← { "type":"done",      "sessionId":"sess_abc", "time":... }

→ { "type":"ping" }
← { "type":"pong",       "sessionId":"sess_abc", "serverTime":... }
```

---

## Multi-Session Architecture / 多会话架构

```
                        nx-ce serve (single Node.js process)
  ┌───────────────────────────────────────────────────────────┐
  │  WebSocket Server (127.0.0.1:3100)                       │
  │                                                           │
  │  SessionManager                                           │
  │  ┌─────────────────────────────────────────────────────┐  │
  │  │  "tab-1": { agentQuery(), messageChannel, queue }   │  │
  │  │  "tab-2": { agentQuery(), messageChannel, queue }   │  │
  │  │  "tab-3": { agentQuery(), messageChannel, queue }   │  │
  │  └──────────────────────┬──────────────────────────────┘  │
  │              spawn each | (SDK manages CLI processes)     │
  │         Claude CLI ─────┴──── Claude CLI ───── Claude CLI │
  └───────────────────────────────────────────────────────────┘
```

### Concurrency guarantees / 竞态保护

| Race / 竞态 | Solution / 方案 |
|-------------|----------------|
| Concurrent session creation | `_pendingCreates` Map deduplicates in-flight creation promises |
| SDK response routing | Each session has independent `for await` loop, writes only to `session.client` |
| State file overwrite | Per-session files (`{name}.json`) + write lock |
| Message ordering | Per-session `MonotonicClock` ensures strict time ordering |
| Client disconnect cleanup | Null client ref + clear queue + 5-min idle timeout auto-destroy |

---

## `nx-ce status` — Instance Status / 查看实例状态

```bash
nx-ce status                  # List all instances
nx-ce status --name chat-1    # Show specific instance
```

```json
{ "name": "chat-1", "pid": 12345, "lifecycleState": "running",
  "sessionId": "sess_abc", "model": "claude-sonnet-4-6",
  "port": 3100, "host": "MY-PC" }
```

---

## `nx-ce skills` — List Available Skills / 列出可用 Skill

```bash
nx-ce skills --cwd "D:/project"
```

```json
{ "skills": ["code-review", "browse", ...],
  "tools": ["Read", "Edit", "Bash", ...],
  "slashCommands": ["code-review", ...],
  "agents": ["Explore", ...] }
```

---

## State Persistence / 状态持久化

State files at `~/.nx-ce/instances/{name}.json`:

```json
{
  "name": "chat-tab-1",
  "pid": 12345,
  "startedAt": "2026-06-06T10:30:00.000Z",
  "updatedAt": "2026-06-06T11:00:00.000Z",
  "sessionId": "sess_abc123",
  "model": "claude-sonnet-4-6",
  "host": "MY-PC",
  "machineId": "a1b2c3d4-e5f6-...",
  "lifecycleState": "running",
  "port": 3100,
  "usage": { "inputTokens": 1500, "outputTokens": 3200, ... }
}
```

| lifecycleState | Meaning / 含义 |
|----------------|----------------|
| `running` | Normal operation / 正常运行 |
| `stopped` | Clean shutdown / 正常关闭 |
| `crashed` | Unexpected exit / 异常退出 |
| `resuming` | Session recovery in progress / 恢复中 |

---

## Architecture / 架构

```
Chrome Extension / 浏览器扩展
       ↕ WebSocket (ws://127.0.0.1:3100)
nx-ce serve (Node.js)
  ├─ SessionManager → agentQuery()
  │                     ↕
  │                  Claude CLI
  │
  └─ (Native Host via exec.Command → nx-ce query --resume)
```

---

## Development / 开发

```bash
# One-shot query
node ./bin/nx-ce.js query "你好"

# Start server
node ./bin/nx-ce.js serve --port 3100

# Run tests (in another terminal)
node test/serve-test.mjs

# Syntax check
node -c src/*.js
```

---

## Test / 测试

```bash
# Terminal 1: start server
node bin/nx-ce.js serve --port 3100

# Terminal 2: run tests
node test/serve-test.mjs

# Expected output:
#   PASS: 14  FAIL: 0
```

Tests cover: connection, ping/pong, single-session query, multi-session isolation, 3 concurrent sessions, long conversation resume, listSessions, closeSession, getSkills, getStatus.

---

## License

MIT
