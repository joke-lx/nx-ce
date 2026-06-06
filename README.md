# nx-ce — Claude Engine

[![npm version](https://img.shields.io/npm/v/nx-ce)](https://www.npmjs.com/package/nx-ce)
[![CI](https://github.com/joke-lx/nx-ce/actions/workflows/npm-publish.yml/badge.svg)](https://github.com/joke-lx/nx-ce/actions/workflows/npm-publish.yml)

**nx-ce** is a lightweight Node.js adapter for `@anthropic-ai/claude-agent-sdk`. As of **v0.2**, it provides a single mode:

- **`nx-ce serve`** — WebSocket multi-session server (persistent, concurrent clients). All consumers (CLI scripts, Chrome extensions, native_host) connect via this single WS endpoint.

**nx-ce** 是一个轻量级 Node.js 适配器，封装了 `@anthropic-ai/claude-agent-sdk`。
**v0.2 起只提供一种模式**：`nx-ce serve` 启动 WebSocket 多会话服务器。
所有调用方（CLI 脚本 / Chrome 扩展 / native_host）都通过这个唯一的 WS 端点与 SDK 通信。

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
# Start WebSocket server (the only mode)
nx-ce serve --port 3100

# In another terminal, run tests
node test/serve-test.mjs
```

> **v0.2 breaking change**: `nx-ce query` and `nx-ce skills` CLI subcommands removed. All consumers must use the WebSocket protocol. See the [Protocol](#websocket-protocol--websocket-协议) section below.

> **v0.2 破坏性变更**：移除 `nx-ce query` 和 `nx-ce skills` 子命令。所有调用方必须使用 WebSocket 协议。

---

## `nx-ce serve` — WebSocket Multi-Session Server / WebSocket 多会话服务器

**Single process. Multiple concurrent sessions. Each session has its own cwd.**

单例进程。多会话隔离。每个会话可指定自己的工作目录。

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
| `--cwd <path>` | Default working directory / 默认工作目录 |
| `--env "KEY=val,..."` | Extra env vars / 额外环境变量 |

> WebSocket address: `ws://127.0.0.1:3100` (localhost only)

### Singleton guarantee / 单例保证

```bash
nx-ce serve --port 3100      # first → OK
nx-ce serve --port 3100      # second → Port already in use — another instance is running
```

---

## Multi-Session / 多会话管理

### Auto-create on first query / 首次 query 自动创建

Session 是**隐式创建**的。第一次发 `query` 时自动创建 SDK 会话，之后同名的 query 续接上下文：

```javascript
// 新会话 "proj-a"，工作目录 D:/project-a
→ { "type": "query", "session": "proj-a", "cwd": "D:/project-a", "prompt": "分析目录结构" }

// 新会话 "proj-b"，工作目录 D:/project-b（不同的 session 名 = 不同的 agentQuery）
→ { "type": "query", "session": "proj-b", "cwd": "D:/project-b", "prompt": "分析目录结构" }

// 同一 session 名 + 不同 cwd → 也是独立的 agentQuery
→ { "type": "query", "session": "proj-a", "cwd": "D:/project-a/src", "prompt": "分析 src" }
```

内部标识 key 格式为 `{name}:{cwd}`：

```
proj-a:D~project-a       → SDK 会话 A
proj-b:D~project-b       → SDK 会话 B
proj-a:D~project-a~src   → SDK 会话 C
```

### Close session / 关闭会话

```javascript
// 关闭精确会话（指定 cwd）
→ { "type": "closeSession", "session": "proj-a", "cwd": "D:/project-a" }

// 关闭该 name 下所有 cwd 变体
→ { "type": "closeSession", "session": "proj-a" }
```

### Idle auto-reclaim / 空闲自动回收

客户端断开连接 5 分钟后，session 自动销毁。**历史会话保留**：
内存中的 session 销毁，但磁盘状态文件保留并标记为 `lifecycleState: 'stopped'`。
`listSessions` 会同时返回活跃 session（绿色）和历史 session（灰色虚线，可恢复）。

### List sessions / 查看会话

```javascript
→ { "type": "listSessions" }
← { "type": "session_list", "sessions": [
    { "name": "proj-a", "cwd": "D:/project-a", "sessionId": "sess_xxx",
      "processing": false, "lifecycleState": "active" },
    { "name": "proj-b", "cwd": "D:/project-b", "sessionId": "sess_yyy",
      "lifecycleState": "stopped",
      "startedAt": "...", "updatedAt": "..." }
  ]}
```

| lifecycleState | 含义 |
|----------------|------|
| `active` | 内存中活跃，可直接发 query |
| `stopped` | 已关闭但保留在磁盘，发 query 会自动 resume（`options.resume = sessionId`） |

### Resume a historical session / 恢复历史会话

直接对历史 session 发 `query`，服务端会自动用磁盘上保存的 `sessionId` 续接：

```javascript
→ { "type": "query", "session": "proj-a", "cwd": "D:/project-a", "prompt": "继续上次的话题" }
// server: readState('proj-a:D~/project-a') → sessionId → options.resume
// 上下文自动恢复
```

---

## WebSocket Protocol / WebSocket 协议

Server: `ws://127.0.0.1:PORT`. All messages are JSON (no length prefix).

### Client → Server / 客户端发送

| type | Fields / 字段 | Description / 说明 |
|------|---------------|-------------------|
| `query` | `prompt: string`, `session?: string`, `cwd?: string`, `id?: string` | Submit a query / 发起查询 |
| `ping` | — | Heartbeat / 心跳 |
| `getSkills` | `session?: string`, `cwd?: string` | Fetch skills/tools/agents / 拉取元数据 |
| `getStatus` | `session?: string`, `cwd?: string` | Query session status / 查询状态 |
| `closeSession` | `session: string`, `cwd?: string` | Close session(s) / 关闭会话 |
| `listSessions` | — | List all active sessions / 列出会话 |

`session` defaults to `"default"`.

```json
→ { "type": "query",        "session": "proj-a", "cwd": "D:/project-a", "prompt": "分析" }
→ { "type": "ping" }
→ { "type": "getSkills",    "session": "proj-a" }
→ { "type": "getStatus",    "session": "proj-a", "cwd": "D:/project-a" }
→ { "type": "closeSession", "session": "proj-a", "cwd": "D:/project-a" }
→ { "type": "closeSession", "session": "proj-a" }
→ { "type": "listSessions" }
```

### Server → Client / 服务端发送

**Connection / 连接建立:**

```json
← { "type": "connected", "port": 3100, "host": "MY-PC",
    "machineId": "744e51b9-...", "serverTime": 1780736149028 }
```

**Session init (auto-push on first query per session) / 会话初始化（自动推送）:**

```json
← { "type": "init", "sessionId": "sess_xxx", "model": "claude-sonnet-4-6",
    "cwd": "D:/project-a",
    "skills": ["browse", "code-review", ...],
    "tools": ["Read", "Edit", "Bash", ...],
    "slashCommands": ["code-review", "ship", ...],
    "agents": ["Explore", "code-reviewer", ...],
    "claudeCodeVersion": "1.0.0",
    "permissionMode": "bypassPermissions",
    "apiKeySource": "env",
    "mcpServers": [{ "name": "...", "status": "connected" }],
    "plugins": [{ "name": "...", "path": "..." }],
    "outputStyle": "default",
    "betas": [],
    "fastModeState": null }
```

**`getSkills` response (按需查询) / `getSkills` 响应:**

```json
← { "type": "skills", "sessionId": "sess_xxx", "model": "claude-sonnet-4-6",
    "cwd": "D:/project-a",
    "skills": ["browse", "code-review", ...],
    "tools": ["Read", "Edit", "Bash", ...],
    "slashCommands": ["code-review", "ship", ...],
    "agents": ["Explore", "code-reviewer", ...],
    "claudeCodeVersion": "1.0.0",
    "permissionMode": "bypassPermissions",
    "apiKeySource": "env",
    "mcpServers": [...], "plugins": [...], "outputStyle": "...",
    "betas": [...], "fastModeState": null,
    "note": "skills/tools/agents are name-only; description requires SDK supportedCommands() (not exposed)" }
```

| 字段 | 类型 | 来源 |
|------|------|------|
| `skills` / `tools` / `slashCommands` / `agents` | `string[]` | SDK init 消息（仅名称，**无 description**） |
| `mcpServers` | `[{name, status}]` | SDK init 消息（连接状态） |
| `plugins` | `[{name, path}]` | SDK init 消息 |
| `claudeCodeVersion` | `string` | SDK init 消息 |
| `permissionMode` | `string` | SDK init 消息（`bypassPermissions` 等） |
| `apiKeySource` | `string` | SDK init 消息（`env` / `keychain` 等） |
| `outputStyle` | `string` | SDK init 消息（`default` 等） |
| `betas` | `string[]` | SDK init 消息（beta 特性） |
| `fastModeState` | `object \| null` | SDK init 消息（快速模式状态） |

**Query response (streamed chunks) / 查询响应（流式块）:**

```json
← { "type": "turn_start", "turn": "turn_xxx", "time": ... }
← { "type": "text",     "content": "这是一段回复...", "time": ... }
← { "type": "thinking", "content": "模型思考过程...", "time": ... }
← { "type": "tool_use", "name": "readFile", "input": {...} }
← { "type": "done",     "sessionId": "sess_xxx", "time": ... }
```

**Other / 其他:**

```json
← { "type": "pong",          "sessionId": "sess_xxx", "serverTime": ... }
← { "type": "status",        "session": "proj-a", "cwd": "D:/project-a", "sessionId": "...", "isActive": true }
← { "type": "session_list",  "sessions": [{ "name":"proj-a", "cwd":"D:/project-a", ... }, ...] }
← { "type": "session_closed","session": "proj-a", "cwd": "D:/project-a" }
← { "type": "error",         "content": "error message" }
```

> 完整 `skills` 响应见上方「`getSkills` response」小节。

### Full exchange example / 完整示例

```
→ { "type":"query", "session":"proj-a", "cwd":"D:/project-a", "prompt":"Hello" }
← { "type":"turn_start", "turn":"turn_xxx", "time":... }
← { "type":"text",       "content":"Hello! How can I help?" }
← { "type":"done",       "sessionId":"sess_abc", "time":... }

→ { "type":"ping" }
← { "type":"pong",       "sessionId":"sess_abc", "serverTime":... }
```

---

## Architecture / 架构

```
                        nx-ce serve (single Node.js process)
  ┌──────────────────────────────────────────────────────────┐
  │  WebSocket Server (127.0.0.1:3100)                       │
  │                                                           │
  │  SessionManager                                           │
  │  ┌─────────────────────────────────────────────────────┐  │
  │  │  "proj-a:D~/project-a" → agentQuery(cwd: project-a) │  │
  │  │  "proj-b:D~/project-b" → agentQuery(cwd: project-b) │  │
  │  │  "proj-a:D~/other"    → agentQuery(cwd: other)     │  │
  │  └──────────────────────┬──────────────────────────────┘  │
  │              spawn each | (SDK manages CLI processes)     │
  │    Claude CLI ──────────┴── Claude CLI ──── Claude CLI    │
  └───────────────────────────────────────────────────────────┘
```

### Session identity / 会话标识

Session key = `{name}:{cwd}`. Same name + different cwd = different SDK session.
Each session has its own `agentQuery()`, `MessageChannel`, `MonotonicClock`, and state file.

### Concurrency guarantees / 竞态保护

| Race / 竞态 | Solution / 方案 |
|-------------|----------------|
| Concurrent session creation | `_pendingCreates` Map deduplicates in-flight creation promises |
| SDK response routing | Each session has independent `for await` loop, writes only to `session.client` |
| State file overwrite | Per-session files (`{name~cwd}.json`) |
| Message ordering | Per-session `MonotonicClock` ensures strict ordering |
| Client disconnect cleanup | Null client ref + clear queue + 5-min idle timeout auto-destroy |

---

## State Persistence / 状态持久化

State files at `~/.nx-ce/instances/{key}.json`. Key format: `{name}~{cwd}`.

```json
{
  "name": "proj-a:D~/project-a",
  "sessionId": "sess_abc123",
  "model": "claude-sonnet-4-6",
  "cwd": "D:/project-a",
  "host": "MY-PC",
  "machineId": "744e51b9-...",
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

## Development / 开发

```bash
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
