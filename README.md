# nx-ce — Claude Engine

[![npm version](https://img.shields.io/npm/v/nx-ce)](https://www.npmjs.com/package/nx-ce)
[![CI](https://github.com/joke-lx/nx-ce/actions/workflows/npm-publish.yml/badge.svg)](https://github.com/joke-lx/nx-ce/actions/workflows/npm-publish.yml)

**nx-ce** 是一个轻量级 Node.js 适配器，封装了 `@anthropic-ai/claude-agent-sdk`。
通过长度前缀的 JSON 协议在 stdin/stdout 上暴露 SDK 接口，
支持一次性冷启动查询与 WebSocket 持久化服务器两种运行模式。

**nx-ce** is a lightweight Node.js adapter for `@anthropic-ai/claude-agent-sdk`.
It exposes the SDK via a WebSocket server or stdin/stdout protocol,
supporting both one-shot cold-start queries and persistent server sessions.

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
| `--include-metadata` | 输出中附带 skills/tools/slash_commands 信息 / Include skill/tool metadata in output |
| `--no-persist` | 不持久化会话 / Don't persist session |
| `--env "KEY=value,KEY2=val"` | 额外环境变量 / Extra environment variables |

### `nx-ce serve` — WebSocket 持久化服务器 / WebSocket server

单例进程，多客户端共享一个 SDK 会话，请求排队处理。
Single process with multi-client support and FIFO query queue.

```bash
nx-ce serve                     # 默认端口 3100
nx-ce serve --port 3100         # 指定端口
nx-ce serve --name chat-tab-1
```

| 选项 / Flag | 说明 / Description |
|-------------|-------------------|
| `--name <name>` | 实例名称（默认 `"default"`）/ Instance name |
| `--port <port>` | WebSocket 端口（默认 `3100`）/ WebSocket port |
| `--model <id>` | 模型 ID 覆盖 / Model override |
| `--claude-path <path>` | Claude CLI 可执行文件路径 / Path to Claude CLI binary |
| `--env "KEY=value,..."` | 额外环境变量 / Extra environment variables |

> WebSocket 地址: `ws://127.0.0.1:3100`

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

## WebSocket 协议 / WebSocket Protocol

服务端地址 `ws://127.0.0.1:PORT`（默认 3100）。所有消息均为 JSON 字符串（不含长度前缀）。

Server at `ws://127.0.0.1:PORT` (default 3100). All messages are JSON strings (no length prefix).

### 客户端发送 / Client → Server

| type | 字段 / Fields | 说明 / Description |
|------|---------------|-------------------|
| `query` | `prompt: string`, `id?: string` | 发起查询 / Submit a query |
| `ping` | 无 | 心跳检测 / Heartbeat |
| `getSkills` | 无 | 拉取技能/工具列表 / Fetch skills & tools |

```json
→ { "type": "query", "prompt": "解释这段代码" }
→ { "type": "ping" }
→ { "type": "getSkills" }
```

### 服务端发送 / Server → Client

**连接建立 / On connect:**

```json
← { "type": "connected", "sessionId": "sess_xxx", "port": 3100 }
← { "type": "init", "sessionId": "sess_xxx", "model": "claude-sonnet-4-6",
    "skills": [...], "tools": [...], "slashCommands": [...], "agents": [...] }
```

**查询响应 / Query response (streamed chunks):**

```json
← { "type": "text",     "content": "这是一段回复..." }
← { "type": "thinking", "content": "模型思考过程..." }
← { "type": "tool_use", "name": "readFile", "input": {...}, "id": "toolu_xxx" }
← { "type": "done",     "sessionId": "sess_xxx" }
```

**其他 / Other:**

```json
← { "type": "pong",  "sessionId": "sess_xxx" }
← { "type": "skills", "skills": [...], "tools": [...], "slashCommands": [...], "agents": [...] }
← { "type": "error", "content": "error message" }
```

### 完整示例 / Full exchange

```
→ { "type": "query", "prompt": "Hello" }
← { "type": "text",     "content": "Hello! How can I help you today?" }
← { "type": "done",     "sessionId": "sess_abc123" }

→ { "type": "ping" }
← { "type": "pong",     "sessionId": "sess_abc123" }
```

### 单例机制 / Singleton guarantee

重复启动 `nx-ce serve` 会在同一端口上失败：

```
端口 3100 已被占用 — nx-ce 单例进程已在运行中
Port 3100 already in use — another nx-ce instance is running
```

---

## 协议 / Protocol (stdin/stdout)

`nx-ce query` 子命令仍使用长度前缀 JSON（Chrome Native Messaging 格式）：

```
[4 bytes LE uint32 = 负载长度 / payload length][UTF-8 JSON payload]
```

### 查询（一次性）/ Query (one-shot)

```
→ { "prompt": "...", "model": "...", "systemPrompt": "..." }
← { "text": "...", "sessionId": "sess_xxx" }
```

### 带元数据输出 / With metadata

```
← { "text": "...", "sessionId": "sess_xxx",
    "metadata": { "skills": [...], "tools": [...], "slashCommands": [...] } }
```

---

## 架构 / Architecture

```
Chrome Extension / 浏览器扩展
       ↕ WebSocket (ws://127.0.0.1:3100)
nx-ce serve (Node.js)   ← 单例进程 / singleton process
       ↕ @anthropic-ai/claude-agent-sdk
Claude Code CLI (子进程 / subprocess)
```

---

## 状态持久化 / State

状态持久化到 `~/.nx-ce/instances/{name}.json`。
每个命名实例存储其 PID、会话 ID 和启动时间，用于崩溃恢复和会话续接。

Persisted to `~/.nx-ce/instances/{name}.json`. Each named instance stores its PID, session ID, and start time for crash recovery and session resumption.

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
# 本地运行一次查询 / Run a one-shot query
node ./bin/nx-ce.js query "你好"

# 启动 WebSocket 服务 / Start WebSocket server
node ./bin/nx-ce.js serve --port 3100

# 检查语法 / Check syntax
node -c src/*.js
```

---

## License / 许可证

MIT
