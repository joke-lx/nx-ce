# nx-ce — Claude Engine

[![npm version](https://img.shields.io/npm/v/nx-ce)](https://www.npmjs.com/package/nx-ce)
[![CI](https://github.com/joke-lx/nx-ce/actions/workflows/npm-publish.yml/badge.svg)](https://github.com/joke-lx/nx-ce/actions/workflows/npm-publish.yml)

**A lightweight WebSocket multi-session server** that wraps `@anthropic-ai/claude-agent-sdk`.

Single process. Multiple concurrent Claude sessions. Each session has its own cwd and context.

---

## Philosophy / 设计哲学

nx-ce is **not a library** — it's a **CLI tool** that starts a WebSocket server. All consumers (CLI scripts, Chrome extensions, native_host) talk to it via JSON-over-WebSocket.

这样就不需要 `main` 字段了，也无需 `import { startServe } from 'nx-ce'`——这个包只有一个入口：`npx nx-ce serve`。

---

## Install / 安装

```bash
npm install -g nx-ce
```

---

## Quick Start / 快速开始

```bash
# Start WebSocket server (the only mode)
nx-ce serve --port 43720

# In another terminal, run tests
node test/serve-test.mjs
```

---

## `nx-ce serve` — WebSocket Multi-Session Server

```bash
nx-ce serve                     # default port 43720
nx-ce serve --port 43720
nx-ce serve --name "main" --port 43720 --cwd "D:/project"
```

| Flag | Description |
|------|-------------|
| `--name <name>` | Instance name (default `default`) |
| `--port <port>` | WebSocket port (default `43720`) |
| `--model <id>` | Model override |
| `--claude-path <path>` | Path to Claude CLI executable |
| `--cwd <path>` | Default working directory for sessions |
| `--env "KEY=val,..."` | Extra env vars merged into session |

> WebSocket: `ws://127.0.0.1:43720` (localhost only)

---

## Multi-Session / 多会话管理

### Session identity / 会话标识

第一次 query 自动创建 session。Key = `{name}:{cwd}`：

| `session` | `cwd` | 行为 |
|-----------|-------|------|
| `"proj-a"` | `D:/project-a` | 首次→新建，再次→续接 |
| `"proj-b"` | `D:/project-b` | 全新会话 |
| `"proj-a"` | `D:/project-b` | 全新（name 同但 cwd 不同） |

### List / Close / Resume

```javascript
→ { "type": "listSessions" }
→ { "type": "closeSession", "session": "proj-a", "cwd": "D:/project-a" }
→ { "type": "closeSession", "session": "proj-a" }
→ { "type": "query", "session": "proj-a", "cwd": "D:/project-a", "prompt": "继续" }
//   ↑ 自动 resume 磁盘上的历史 session
```

---

## WebSocket Protocol / WebSocket 协议

### Client → Server

| type | Fields | Description |
|------|--------|-------------|
| `query` | `prompt`, `session?`, `cwd?`, `id?` | Submit a query |
| `ping` | — | Heartbeat |
| `getSkills` | `session?`, `cwd?` | Fetch Claude skills/tools/agents |
| `getStatus` | `session?`, `cwd?` | Query session status |
| `closeSession` | `session`, `cwd?` | Close session(s) |
| `listSessions` | — | List all sessions |

### Server → Client

```
← { "type": "connected", "port": 43720, "host": "...", "machineId": "...", "serverTime": ... }
← { "type": "init",      "sessionId": "...", "model": "claude-sonnet-4-6", "skills": [...], "tools": [...], ... }
← { "type": "turn_start", "turn": "turn_xxx", "time": ... }
← { "type": "text",       "content": "reply...", "time": ... }
← { "type": "thinking",   "content": "thinking...", "time": ... }
← { "type": "tool_use",   "name": "readFile", "input": {...} }
← { "type": "done",       "sessionId": "...", "time": ... }
← { "type": "pong",       "serverTime": ... }
← { "type": "skills",     "sessionId": "...", "skills": [...], "tools": [...], ... }
← { "type": "status",     "session": "...", "cwd": "...", "isActive": true }
← { "type": "session_list", "sessions": [...] }
← { "type": "session_closed", "session": "...", "cwd": "..." }
```

> `session` defaults to `"default"`. Full `getSkills` response includes `mcpServers`, `plugins`, `claudeCodeVersion`, etc.

---

## Architecture / 架构

```
  nx-ce (CLI)
  └─ bin/nx-ce.js          ← 唯一入口
       └─ src/
           ├─ cli/          ← 参数解析 + 子命令路由
           │   ├─ parser.js
           │   ├─ resolve.js
           │   └─ commands.js
           ├─ session/      ← 会话管理
           │   ├─ key.js    ←  key 工具函数
           │   ├─ state.js  ←  数据模型
           │   ├─ store.js  ←  磁盘持久化
           │   └─ manager.js←  SessionManager
           ├─ server.js     ←  WebSocket 服务器
           ├─ protocol/     ←  wire protocol
           │   └─ native.js
           └─ util.js       ←  工具函数
```

### Concurrency guarantees

| Race | Solution |
|------|----------|
| Concurrent session creation | `_pendingCreates` Map deduplicates in-flight promises |
| SDK response routing | Per-session `for await` loop, writes only to `session.client` |
| State file overwrite | Per-session files under `~/.nx-ce/instances/{key}.json` |
| Message ordering | Per-session `MonotonicClock` |
| Client disconnect | Null client ref + clear queue + 5-min idle timeout |

---

## Development / 开发

```bash
# Start server
nx-ce serve --port 43720

# Run tests (another terminal)
node test/serve-test.mjs

# Expected: PASS: 14  FAIL: 0
```

Tests cover: connection, ping/pong, single query, multi-session isolation, 3 concurrent sessions, conversation resume, listSessions, closeSession, getSkills, getStatus.

---

## License

MIT
