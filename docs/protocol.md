# nx-ce WebSocket Protocol / WebSocket 协议

**Protocol version:** 1.0  **Endpoint:** `ws://127.0.0.1:43720`

---

## Overview / 概述

All messages are JSON-over-WebSocket (utf-8). Every client message may carry optional `session` and `cwd` fields to target a specific conversation. The server responds with typed JSON messages.

所有消息均为 UTF-8 JSON-over-WebSocket。每条客户端消息可选带 `session` 和 `cwd` 字段以指定目标会话。

---

## Client → Server / 客户端 → 服务端

### `query` — Submit a message / 提交查询

```json
{
  "type": "query",
  "session": "default",
  "cwd": "D:/project",
  "prompt": "Hello",
  "id": "req_123",
  "model": "claude-sonnet-4-6",
  "permissionMode": "bypassPermissions",
  "skills": ["skill-a", "skill-b"]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `prompt` | ✅ | User message text |
| `session` | ❌ (default `"default"`) | Session name |
| `cwd` | ❌ (uses server cwd) | Working directory |
| `id` | ❌ | Client-side request tracker |
| `model` | ❌ | Model override (non-empty string) |
| `permissionMode` | ❌ | Permission mode (see valid values below) |
| `skills` | ❌ | Explicit skill list (forces new session) |

**Permission modes:** `"default"`, `"acceptEdits"`, `"bypassPermissions"`, `"plan"`, `"dontAsk"`, `"auto"`

---

### `ping` — Heartbeat / 心跳

```json
{ "type": "ping" }
```

---

### `getSkills` — Fetch available skills & tools / 获取技能列表

```json
{ "type": "getSkills", "session": "default", "cwd": "D:/project" }
```

---

### `getStatus` — Query session status / 查询会话状态

```json
{ "type": "getStatus", "session": "default", "cwd": "D:/project" }
```

---

### `closeSession` — Close session(s) / 关闭会话

```json
{ "type": "closeSession", "session": "proj-a", "cwd": "D:/project" }
```

- With `cwd`: close one specific session
- Without `cwd`: close all sessions sharing that name
- Session is preserved to disk (marked `STOPPED`), can be resumed

---

### `cancel` — Cancel active turn / 中断当前回复

```json
{ "type": "cancel", "session": "default", "cwd": "D:/project" }
```

Cancel a currently processing turn **without destroying the session**. The session remains alive and can accept new queries immediately after the cancelled turn's `done` message.

中断当前正在处理的回复，**不销毁会话**。已取消 turn 的 `done` 消息到达后，会话即可接受新查询。

**Behavior details / 行为细节:**

| Aspect | Behavior |
|--------|----------|
| Session lifecycle | **Not destroyed** — state, queue, history are preserved |
| Client binding | Current turn's client is detached, subsequent outputs are dropped |
| Queue processing | The session's next queued query is processed **after** the current turn completes naturally |
| Turn completion | The consumer loop runs to `result` → sets `processing=false` → calls `_processQueue` |
| In-flight output | Any text already sent before `cancel` arrives cannot be unsent |

**Implementation note:** `cancel` does NOT call `session.response.interrupt()` because that terminates the SDK consumer loop (`for await`), breaking the session permanently. Instead it detaches the client and lets the current turn drain naturally.

`cancel` 不会调用 `session.response.interrupt()`，因为那会终止 SDK consumer 循环，永久破坏会话。而是 detach client，让当前 turn 自然跑完。

---

### `listSessions` — List all sessions / 列出所有会话

```json
{ "type": "listSessions" }
```

Returns both active (in-memory) and historical (disk-persisted) sessions.

---

## Server → Client / 服务端 → 客户端

### `connected` — Connection established / 连接成功

```json
{
  "type": "connected",
  "port": 43720,
  "host": "my-pc",
  "machineId": "abc123",
  "serverTime": 1700000000000
}
```

Sent immediately after WebSocket handshake.

---

### `init` — Session metadata / 会话初始化信息

```json
{
  "type": "init",
  "sessionId": "uuid-xxx",
  "model": "claude-sonnet-4-6",
  "cwd": "D:/project",
  "skills": ["skill-a"],
  "tools": ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
  "slashCommands": ["/help"],
  "agents": ["code-reviewer"],
  "claudeCodeVersion": "0.3.x",
  "permissionMode": "bypassPermissions",
  "apiKeySource": "env",
  "mcpServers": [],
  "plugins": [],
  "outputStyle": "full",
  "betas": [],
  "fastModeState": "disabled"
}
```

Sent once when a session is created or resumed.

---

### `turn_start` — Turn begins / 开始处理

```json
{ "type": "turn_start", "turn": "turn_xxx", "time": 1700000000001 }
```

---

### `text` — Streaming text output / 流式文本输出

```json
{ "type": "text", "content": "Hello! ", "time": 1700000000002 }
```

---

### `thinking` — Thinking block / 思考过程

```json
{ "type": "thinking", "content": "Let me think...", "time": 1700000000003 }
```

---

### `tool_use` — Tool call / 工具调用

```json
{
  "type": "tool_use",
  "name": "Read",
  "input": { "file_path": "/path/to/file" },
  "id": "toolu_xxx",
  "time": 1700000000004
}
```

---

### `done` — Turn complete / 回复完成

```json
{ "type": "done", "sessionId": "uuid-xxx", "time": 1700000000005 }
```

After `done`, the session is ready for the next `query`.

---

### `pong` — Heartbeat response / 心跳回复

```json
{ "type": "pong", "serverTime": 1700000000000 }
```

---

### `skills` — Skills query response / 技能列表

```json
{
  "type": "skills",
  "sessionId": "uuid-xxx",
  "model": "claude-sonnet-4-6",
  "cwd": "D:/project",
  "skills": [...],
  "tools": [...],
  "slashCommands": [...],
  "agents": [...],
  "claudeCodeVersion": "0.3.x",
  "permissionMode": "bypassPermissions",
  "apiKeySource": "env",
  "mcpServers": [],
  "plugins": [],
  "outputStyle": "full",
  "betas": [],
  "fastModeState": "disabled",
  "note": "skills/tools/agents are name-only; description requires SDK supportedCommands()"
}
```

---

### `status` — Session status response / 会话状态

```json
{
  "type": "status",
  "session": "default",
  "cwd": "D:/project",
  "sessionId": "uuid-xxx",
  "lifecycleState": "running",
  "isActive": true,
  "queueLength": 0,
  "processing": false,
  "model": "claude-sonnet-4-6"
}
```

---

### `session_list` — Session list response / 会话列表

```json
{
  "type": "session_list",
  "sessions": [
    {
      "key": "default:D:\\project",
      "name": "default",
      "cwd": "D:\\project",
      "sessionId": "uuid-xxx",
      "model": "claude-sonnet-4-6",
      "queueLength": 0,
      "processing": false,
      "lifecycleState": "active",
      "startedAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:01:00.000Z"
    }
  ]
}
```

---

### `session_closed` — Session close confirmation / 会话关闭确认

```json
{ "type": "session_closed", "session": "proj-a", "cwd": "D:/project" }
```

---

### `cancelled` — Cancel confirmation / 取消确认

```json
{ "type": "cancelled", "session": "default", "cwd": "D:/project" }
```

Sent when `cancel` successfully interrupts an active turn.

当 `cancel` 成功中断一个活跃 turn 时发送。

**Client flow / 客户端流程:**

```
   ┌──── WS Client ────┐    ┌── nx-ce Server ───┐
   │                    │    │                    │
   │ send: query(...)   │───▶│ processing = true  │
   │                    │    │                    │
   │ send: cancel(...)  │───▶│ client = null      │
   │                    │    │ processing = true   │
   │ receive: cancelled │◀───│ (kept until done)   │
   │                    │    │                    │
   │ receive: done      │◀───│ processing = false  │
   │ (from cancelled    │    │ → processQueue()   │
   │  turn, skip it)    │    │                    │
   │                    │    │                    │
   │ send: query(...)   │───▶│ new turn starts    │
   │                    │    │                    │
   └────────────────────┘    └────────────────────┘
```

---

### `cancel_failed` — Cancel failure / 取消失败

```json
{
  "type": "cancel_failed",
  "content": "no active turn to cancel"
}
```

Sent when `cancel` is sent but no turn is currently processing (session idle, or already cancelled).

当 `cancel` 发送时没有活跃 turn 正在处理时发送。

```json
{
  "type": "cancel_failed",
  "content": "..."
}
```

Other possible failure messages: session not found, session closed.

---

### `error` — Error response / 错误响应

```json
{ "type": "error", "content": "description of the error" }
```

---

## Cancel Scenarios / 取消场景

| Scenario / 场景 | `cancel` effect / cancel 效果 | Server response / 服务端响应 |
|----------|------------------------|---------------------|
| Active turn processing / 正在回复 | Client detached, turn drains silently, queue waits | `cancelled` |
| Session idle (no active turn) / 空闲 | Nothing happens | `cancel_failed` |
| Session closed / 已关闭 | Nothing happens | `cancel_failed` |
| Session does not exist / 不存在 | Nothing happens | `cancel_failed` |

---

## Error Codes / 错误码

| Error / 错误 | HTTP-style Code | Cause / 原因 |
|-------|-------|-------|
| `invalid JSON` | 400 | Malformed message |
| `query missing prompt` | 400 | No `prompt` field |
| `model must be a non-empty string` | 400 | Empty or non-string model |
| `Invalid permissionMode` | 400 | Unrecognized permission mode |
| `session create failed: ...` | 500 | SDK initialization error |
| `unknown type: ...` | 400 | Unrecognized message type |
| `no active turn to cancel` | 409 | Cancel sent when idle |
| `getSkills failed: ...` | 500 | Probe session error |

---

## Data Types / 数据类型

| Type | Description | Example |
|------|-------------|---------|
| `sessionId` | UUIDv4 identifying a Claude SDK session | `"a1b2c3d4-..."` |
| `turn` | Turn identifier | `"turn_mq89tqoi_xxx"` |
| `time` | Monotonic clock value (ms since session start) | `1781107284046` |
| `serverTime` | Unix epoch ms | `1700000000000` |
