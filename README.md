# nx-ce — Claude Engine

[![npm version](https://img.shields.io/npm/v/nx-ce)](https://www.npmjs.com/package/nx-ce)
[![CI](https://github.com/joke-lx/nx-ce/actions/workflows/npm-publish.yml/badge.svg)](https://github.com/joke-lx/nx-ce/actions/workflows/npm-publish.yml)

**A persistent WebSocket multi-session server** wrapping `@anthropic-ai/claude-agent-sdk`.

**一个持久化的 WebSocket 多会话服务端**，封装了 `@anthropic-ai/claude-agent-sdk`。

Unlike running `claude` in a single terminal, nx-ce runs a long-lived process that hosts **multiple independent Claude Code sessions** — each with its own working directory, context, and conversation history — accessible by any JSON-over-WebSocket client.

与在单个终端中运行 `claude` 不同，nx-ce 是一个常驻进程，可同时托管 **多个独立的 Claude Code 会话**——每个会话拥有独立的工作目录、上下文和对话历史——任何 WebSocket 客户端均可通过 JSON 协议访问。

---

## The Problem / 问题

Claude Code is designed as a single-session, single-user CLI tool. This creates friction when you want to:

Claude Code 本质上是单会话、单用户的 CLI 工具。在以下场景中会产生摩擦：

| Scenario / 场景 | Pain Point / 痛点 |
|----------|------------|
| Chrome extension wants to query Claude / 浏览器扩展需要调用 Claude | Must spawn a new process per request, slow and wasteful / 每次请求都要新建进程，慢且浪费 |
| Multiple projects need parallel sessions / 多项目需要并行会话 | CLI blocks on one conversation at a time / CLI 一次只能阻塞在一个对话上 |
| Tools need programmatic access / 工具需要编程式访问 | No stable API — stdin/stdout is fragile / 没有稳定 API — stdin/stdout 很脆弱 |
| Long-running context / 长期上下文 | Each new query starts from scratch, no history / 每次查询从头开始，无历史延续 |

**nx-ce solves this** by running Claude Code SDK as a persistent service, decoupling the client from the lifecycle of the AI process.

**nx-ce 的解法**：将 Claude Code SDK 作为一个持久化服务运行，客户端与 AI 进程生命周期解耦。

---

## Why nx-ce / 为什么用 nx-ce

| Use Case / 使用场景 | Without nx-ce / 不用 nx-ce | With nx-ce / 用 nx-ce |
|----------|---------------------|-----------------|
| Chrome extension 调用 Claude | Per-query `child_process.spawn` | `ws.send()` — 常驻连接 |
| 同时维护 3 个项目上下文 | 开 3 个终端，互不共享 | 一个进程 3 个 session，统一管理 |
| 工具链集成 | 临时文件 + stdin 解析 | 标准 WebSocket JSON 协议 |
| 对话续接 | 每次重新描述上下文 | `name:cwd` 自动恢复历史 |

---

## Install / 安装

```bash
npm install -g nx-ce
```

---

## Quick Start / 快速开始

```bash
# Terminal 1: Start the WebSocket server
# 终端 1：启动服务端
nx-ce serve --port 43720

# Terminal 2: Send a query
# 终端 2：发送查询
node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('ws://127.0.0.1:43720');
ws.on('open', () => ws.send(JSON.stringify({
  type: 'query',
  session: 'demo',
  cwd: process.cwd(),
  prompt: 'Say hello in one word'
})));
ws.on('message', d => console.log(JSON.parse(d.toString())));
"
```

Or run the test suite / 或运行测试：

```bash
node test/serve-test.mjs
# Expected: PASS: 14  FAIL: 0
```

---

## Design Philosophy / 设计哲学

### Persistent Server, Ephemeral Clients / 服务常驻，客户端按需连接

Clients connect, send queries, and disconnect — the Claude session stays alive. No process-per-query overhead.

客户端连接、查询、断开——Claude 会话一直在。没有每次查询新建进程的开销。

```
┌──────────┐  connect / query / disconnect
│  Client  │────────────────────────────┐
└──────────┘                            │
                                        ▼
                              ┌─────────────────────┐
                              │   nx-ce (server)    │
                              │  ┌─ session: proj-a │
                              │  ├─ session: proj-b │
                              │  └─ session: proj-c │
                              └─────────────────────┘
```

### Session = Name + Working Directory / 会话 = 名称 + 工作目录

Two dimensions of isolation / 两个隔离维度：

| Same name, same cwd / 同名同目录 | Same conversation — resume history / 同一对话，续接历史 |
|---------------------|------------------------------------|
| Same name, different cwd / 同名不同目录 | New conversation, independent state / 新对话，独立状态 |
| Different name / 不同名称 | Always a new conversation / 始终新对话 |

This lets one client manage conversations across multiple projects, or multiple clients share the same server.

一个客户端可管理跨多个项目的对话，或多个客户端共享同一服务端。

### Session Preservation by Default / 会话默认持久化

Sessions persist to disk (`~/.nx-ce/instances/`). Clients can close and reconnect — the conversation resumes where it left off. Token usage is tracked and survives restarts.

会话持久化到磁盘 (`~/.nx-ce/instances/`)。客户端断开后重连——对话从中断处继续。Token 用量跟踪不因重启丢失。

### Unified Protocol / 统一协议

All consumers (CLI scripts, Chrome extensions, native host processes, tests) talk the same JSON-over-WebSocket protocol. No per-consumer adapters.

所有消费者（CLI 脚本、Chrome 扩展、native_host 进程、测试）使用同一 JSON-over-WebSocket 协议。无需为每种消费者写适配器。

---

## Features / 功能

| Feature / 功能 | Description / 说明 |
|-----------|-----------|
| **Multi-session / 多会话** | Run N independent Claude sessions in one process / 一个进程内运行多个独立 Claude 会话 |
| **Session resume / 会话续接** | Disconnect and reconnect — context is preserved / 断开重连，上下文不丢失 |
| **Per-session cwd / 工作目录隔离** | Each session works in its own directory / 每个会话拥有独立工作目录 |
| **Idle cleanup / 空闲清理** | Sessions auto-close after 5 min of inactivity / 无活动 5 分钟后自动关闭 |
| **Skills passthrough / skills 透传** | Pass custom skills when creating a session / 创建会话时可传入自定义 skills |
| **Model & permission override / 模型与权限覆盖** | Per-query `model` and `permissionMode` with server-side validation / 每次查询可指定 model 和权限模式，服务端白名单校验 |
| **Concurrency safe / 并发安全** | Per-session queues, monotonic clock, creation dedup / 每会话独立队列、单调时钟、创建去重 |
| **Usage tracking / 用量跟踪** | Token consumption tracked per session / 每个会话独立统计 token 消耗 |
| **Graceful shutdown / 优雅关闭** | Clean up all sessions on SIGINT/SIGTERM / 收到退出信号时清理所有会话 |

---

## CLI Reference / CLI 参考

```bash
nx-ce serve                     # Default port / 默认端口 43720
nx-ce serve --port 43720
nx-ce serve --name "main" --port 43720 --cwd "D:/project"
nx-ce status                    # List all instances / 列出所有实例
nx-ce status --name default     # Show one instance / 查看单个实例
nx-ce help                      # Show help / 显示帮助
```

### `serve` flags / 启动参数

| Flag / 参数 | Description / 说明 |
|------|-------------|
| `--name <name>` | Instance name (default `default`) / 实例名称（默认 `default`） |
| `--port <port>` | WebSocket port (default `43720`) / WebSocket 端口（默认 `43720`） |
| `--model <id>` | Model override (e.g. `claude-sonnet-4-6`) / 模型覆盖 |
| `--claude-path <path>` | Path to Claude CLI / Claude CLI 路径 |
| `--cwd <path>` | Default working directory for sessions / 会话默认工作目录 |
| `--env "KEY=val,..."` | Extra env vars merged into session / 注入额外环境变量 |

> WebSocket endpoint / 端点: `ws://127.0.0.1:43720` (localhost only / 仅本地)

---

## Multi-Session / 多会话管理

### Session Identity / 会话标识

The first `query` for a given `(name, cwd)` pair creates a session. Subsequent queries with the same pair resume the existing session.

首次对某 `(name, cwd)` 组合发送 `query` 时创建会话。后续相同组合的查询自动续接已有会话。

| `session` | `cwd` | Behavior / 行为 |
|-----------|-------|----------|
| `"proj-a"` | `D:/project-a` | First → create, later → resume / 首次创建，后续续接 |
| `"proj-b"` | `D:/project-b` | Brand new session / 全新会话 |
| `"proj-a"` | `D:/project-b` | New session (same name, different cwd) / 新会话（同名不同目录） |

### List / Close / Resume / 列表 / 关闭 / 续接

```javascript
→ { "type": "listSessions" }
← { "type": "session_list", "sessions": [...] }

→ { "type": "closeSession", "session": "proj-a", "cwd": "D:/project-a" }
→ { "type": "closeSession", "session": "proj-a" }  // close all with this name / 关闭所有同名会话

→ { "type": "query", "session": "proj-a", "cwd": "D:/project-a", "prompt": "继续" }
//   ↑ Auto-resumes the disk-persisted session / 自动续接磁盘上的历史会话
```

---

## WebSocket Protocol / WebSocket 协议

### Client → Server / 客户端 → 服务端

| type / 类型 | Fields / 字段 | Description / 说明 |
|------|--------|-------------|
| `query` | `prompt`, `session?`, `cwd?`, `id?`, `model?`, `permissionMode?`, `skills?` | Submit a query to a session / 向会话提交查询 |
| `ping` | — | Heartbeat / 心跳 |
| `getSkills` | `session?`, `cwd?` | Fetch available skills/tools/agents |
| `getStatus` | `session?`, `cwd?` | Query session status / 查询会话状态 |
| `closeSession` | `session`, `cwd?` | Close session(s) / 关闭会话 |
| `listSessions` | — | List all active + historical sessions / 列出所有活跃和历史会话 |

### Server → Client / 服务端 → 客户端

```
← { "type": "connected",     "port": 43720, "host": "...", "machineId": "...", "serverTime": ... }
← { "type": "init",          "sessionId": "...", "model": "claude-sonnet-4-6", "skills": [...], "tools": [...], ... }
← { "type": "turn_start",    "turn": "turn_xxx", "time": ... }
← { "type": "text",          "content": "reply...", "time": ... }
← { "type": "thinking",      "content": "thinking...", "time": ... }
← { "type": "tool_use",      "name": "readFile", "input": {...} }
← { "type": "done",          "sessionId": "...", "time": ... }
← { "type": "pong",          "serverTime": ... }
← { "type": "skills",        "sessionId": "...", "skills": [...], "tools": [...], ... }
← { "type": "status",        "session": "...", "cwd": "...", "isActive": true, "queueLength": N }
← { "type": "session_list",  "sessions": [...] }
← { "type": "session_closed","session": "...", "cwd": "..." }
```

> `session` defaults to `"default"` when omitted. The full `getSkills` response includes `mcpServers`, `plugins`, `claudeCodeVersion`, `permissionMode`, etc.
>
> `session` 省略时默认为 `"default"`。完整 `getSkills` 响应包含 `mcpServers`、`plugins`、`claudeCodeVersion`、`permissionMode` 等。

### Permission Mode / 权限模式

`permissionMode` controls how tool executions are handled / 控制工具执行权限：

| Mode / 模式 | Description / 说明 |
|------|-------------|
| `"default"` | Standard behavior, prompts for dangerous operations / 标准行为，危险操作弹窗询问 |
| `"acceptEdits"` | Auto-accept file edit operations / 自动接受文件编辑操作 |
| `"bypassPermissions"` | Bypass all permission checks — escalated privilege / 绕过所有权限检查（提权模式，默认） |
| `"plan"` | Planning mode, no actual tool execution / 计划模式，只读不执行 |
| `"dontAsk"` | Don't prompt, deny if not pre-approved / 不弹窗，未预授权则直接拒绝 |
| `"auto"` | Model classifier decides approve/deny / 模型分类器自动决策 |

### Validation Rules / 校验规则

Both `model` and `permissionMode` are validated on every `query` / 每次 `query` 都会校验：

- `model` — must be a non-empty string / 必须是非空字符串
- `permissionMode` — whitelist check against the 6 valid modes above / 白名单校验（仅以上 6 种）
- Both are **optional** — omitting them uses server defaults / 均为可选，不传则使用服务端默认值

### Full Protocol Reference / 完整协议参考

See [docs/protocol.md](docs/protocol.md) for the complete protocol specification / 完整协议规范见 [docs/protocol.md](docs/protocol.md)。

---

## Architecture / 架构

```
nx-ce (CLI)
└─ bin/nx-ce.js              ← Single entry point / 唯一入口
     └─ src/
         ├─ cli/              ← Argument parsing & subcommand routing / 参数解析 & 子命令路由
         │   ├─ parser.js
         │   ├─ resolve.js
         │   └─ commands.js
         ├─ session/          ← Session management / 会话管理
         │   ├─ key.js        ←  Session identity (name:cwd) / 会话标识
         │   ├─ state.js      ←  Data model & lifecycle enum / 数据模型 & 生命周期枚举
         │   ├─ store.js      ←  Disk persistence (~/.nx-ce/instances/) / 磁盘持久化
         │   └─ manager.js    ←  SessionManager: create, resume, queue, cleanup
         ├─ server.js         ← WebSocket server, message routing, signal handling
         │                      WebSocket 服务端、消息路由、信号处理
         ├─ protocol/         ← Wire protocol (length-prefixed JSON) / 线路协议（长度前缀 JSON）
         │   └─ native.js
         └─ util.js           ← ID generation, monotonic clock, machine ID / 工具函数
```

### State File Layout / 磁盘状态文件

```
~/.nx-ce/
├── machine-id               ← Persistent machine identifier / 持久化机器标识
└── instances/
    ├── default~D~project-a.json   ← Session state per (name:cwd) / 每个 (name:cwd) 独立状态文件
    ├── proj-a~D~project-a.json
    └── proj-b~D~project-b.json
```

### Concurrency Guarantees / 并发保证

| Race / 竞态 | Solution / 解法 |
|------|----------|
| Concurrent session creation / 并发创建 session | `_pendingCreates` Map deduplicates in-flight promises / Map 去重正在创建的 Promise |
| SDK response routing / SDK 回复路由 | Per-session `for await` loop, writes only to `session.client` / 每会话独立消费循环，只写自己的 client |
| State file overwrite / 状态文件覆盖 | Per-session files under `~/.nx-ce/instances/{key}.json` / 每会话独立文件 |
| Message ordering / 消息排序 | Per-session `MonotonicClock` — strict monotonic `time` field / 每会话独立单调时钟 |
| Client disconnect / 客户端断连 | Null client ref + clear queue + 5-min idle timeout / 置空 client + 清空队列 + 5 分钟空闲超时 |
| Recreate with skills / 带 skills 重建 | Old session destroyed, new one created with fresh skill list / 销毁旧 session，用新 skill 列表重建 |

---

## Development / 开发

```bash
# Start server / 启动服务端
nx-ce serve --port 43720

# Run tests (another terminal) / 运行测试（另开终端）
node test/serve-test.mjs

# Expected: PASS: 14  FAIL: 0
```

Tests cover / 测试覆盖：connection, ping/pong, single query, multi-session isolation, 3 concurrent sessions, conversation resume, listSessions, closeSession, getSkills, getStatus.

---

## License

MIT
