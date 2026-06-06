# nx-ce — Claude Engine

**nx-ce** is a lightweight Node.js adapter for `@anthropic-ai/claude-agent-sdk`. It exposes the SDK over stdin/stdout using a length-prefixed JSON protocol (identical to Chrome native messaging), designed to be spawned and managed by a Go native host.

## Family

| Package | Role |
|---------|------|
| **nx-ce** | Claude Engine — SDK adapter layer |
| [nx-sx](https://github.com/jokelx/nx-sx) | Sandbox eXecution — window/terminal manager |

## Usage

```bash
# One-shot cold-start query
npx nx-ce query "Explain this code" --model claude-haiku-4-5

# Persistent manager process (for native_host exec)
npx nx-ce serve --name chat-tab-1

# Check instance status
npx nx-ce status
npx nx-ce status --name chat-tab-1
```

## Protocol

All IPC uses the same wire format as Chrome native messaging:

```
[4 bytes LE uint32 = payload length][UTF-8 JSON payload]
```

### Query (one-shot)

```
→ { "prompt": "...", "model": "...", "systemPrompt": "..." }
← { "text": "...", "sessionId": "sess_xxx" }
```

### Serve (persistent)

```
→ { "id":"1", "type":"query", "prompt":"..." }
← { "id":"1", "type":"text", "content":"..." }
← { "id":"1", "type":"tool_use", "name":"readFile", "input":{...} }
← { "id":"1", "type":"done", "sessionId":"..." }

→ { "type":"ping" }
← { "type":"pong", "sessionId":"..." }
```

## Architecture

```
Chrome Extension
       ↕ native messaging (4B+JSON)
Native Host (Go)
       ↕ 4B+JSON (via executor.startProcess)
nx-ce serve (Node.js)
       ↕ @anthropic-ai/claude-agent-sdk
Claude Code CLI (subprocess)
```

## State

Persisted to `~/.nx-ce/instances/{name}.json`. Each named instance stores its PID, session ID, and start time for crash recovery and resumption.

## License

MIT
