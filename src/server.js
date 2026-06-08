/**
 * 服务器端 — WebSocket 持久化服务器
 *
 * 薄层：启动 WSS、消息路由、信号处理。
 * 会话管理委托给 SessionManager。
 *
 * 每个会话（session）拥有独立的 agentQuery()、MessageChannel 和状态文件，
 * 天然并行，互不阻塞。
 *
 * 会话标识 = name:cwd（同一 name 不同 cwd 视为不同会话）。
 * 客户端可通过 query 消息的 cwd 字段指定工作目录。
 *
 * 竞态保护：
 *   - session 创建：pendingCreates Map 防止重复创建
 *   - client 绑定：SDK 回复只写 session.client，不走 broadcast
 *   - state 文件：每个 session 独立文件，写锁防并发
 *   - 消息排序：每个 session 独立单调时钟
 */

import { WebSocketServer } from 'ws';
import { hostname, machine, platform, release } from 'node:os';
import { readState, writeState, deleteState, listStates } from './session/store.js';
import { LifecycleState } from './session/state.js';
import { SessionManager, validatePermissionMode } from './session/manager.js';
import { sessionKey } from './session/key.js';
import { getMachineId } from './util.js';

/** 默认端口（与 background WS 客户端统一：bro_chat 侧 43720） */
const DEFAULT_PORT = 43720;

/**
 * 启动 WebSocket 持久化服务。
 */
export async function startServe(options) {
  const { name = 'default', claudePath, model, cwd, env, port = DEFAULT_PORT } = options;

  const machineId = getMachineId();
  const host = hostname();
  const osInfo = `${platform()}/${release()}/${machine()}`;

  const serverState = readState(name);
  const serverSessionId = serverState?.sessionId || null;

  // 创建 SessionManager（cwd 为服务器级默认，session 可覆盖）
  const sessionManager = new SessionManager({ claudePath, model, cwd, env });

  // =================================================================
  // WebSocket 服务器
  // =================================================================

  const wss = new WebSocketServer({ port, host: '127.0.0.1' });

  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${port} already in use — another nx-ce serve is running`);
      }
      reject(err);
    });
  });

  writeState(name, {
    name,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    host,
    machineId,
    port,
    lifecycleState: LifecycleState.RUNNING,
    sessionCount: 0,
  });

  // 客户端连接处理
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({
      type: 'connected',
      port,
      host,
      machineId,
      serverTime: Date.now(),
    }));

    ws.on('message', async (raw) => {
      let req;
      try {
        req = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', content: 'invalid JSON' }));
        return;
      }

      const sessionName = req.session || 'default';

      switch (req.type) {
        case 'query': {
          if (!req.prompt) {
            ws.send(JSON.stringify({ type: 'error', content: 'query missing prompt' }));
            break;
          }

          // 校验客户端传入的可选参数
          let permissionMode;
          try {
            permissionMode = validatePermissionMode(req.permissionMode);
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', content: err.message }));
            break;
          }

          if (req.model !== undefined && (typeof req.model !== 'string' || !req.model.trim())) {
            ws.send(JSON.stringify({ type: 'error', content: 'model must be a non-empty string' }));
            break;
          }

          // 支持每个 query 指定自己的工作目录
          // 同一 session name + 不同 cwd = 不同 SDK 会话
          let session;
          try {
            session = await sessionManager.getOrCreate(sessionName, req.cwd, req.skills, {
              model: req.model,
              permissionMode: permissionMode,
            });
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', content: `session create failed: ${err.message}` }));
            break;
          }

          session.queue.push({
            client: ws,
            prompt: req.prompt,
            id: req.id,
            model: req.model,
            permissionMode: permissionMode,
          });
          sessionManager._processQueue(session);
          break;
        }

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', serverTime: Date.now() }));
          break;

        case 'getSkills': {
          // 每个会话独立获取自己的 skills/tools/MCP，不偷看别人的。
          //   带了 session/cwd → 查/创建指定会话
          //   没带 → 查/创建 __probe__
          const targetName = req.session || '__probe__';
          const targetCwd  = req.cwd || undefined;

          try {
            // 已有初始化好的 metadata → 直接返回
            const key = `${targetName}:${targetCwd}`;
            const existing = sessionManager.sessions.get(key);
            let meta = existing?.metadata;

            // 没有 → 创建 probe 会话，占位触发 init 等 metadata
            if (!meta) {
              const probe = await sessionManager.getOrCreate(targetName, targetCwd);
              probe.queue.push({ client: null, prompt: 'ok', id: null });
              sessionManager._processQueue(probe);
              meta = await Promise.race([
                probe.metadataPromise,
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('probe timeout after 30s')), 30000)
                ),
              ]);
              // 取到后立即销毁（不保留磁盘历史），下次真实 query 开全新会话
              await sessionManager.destroy(key, 'probe complete', { keepHistory: false });
            }

            ws.send(JSON.stringify({
              type: 'skills',
              sessionId: meta.sessionId,
              model: meta.model,
              cwd: meta.cwd,
              skills: meta.skills || [],
              tools: meta.tools || [],
              slashCommands: meta.slashCommands || [],
              agents: meta.agents || [],
              claudeCodeVersion: meta.claudeCodeVersion,
              permissionMode: meta.permissionMode,
              apiKeySource: meta.apiKeySource,
              mcpServers: meta.mcpServers || [],
              plugins: meta.plugins || [],
              outputStyle: meta.outputStyle,
              betas: meta.betas || [],
              fastModeState: meta.fastModeState,
              note: 'skills/tools/agents are name-only; description requires SDK supportedCommands() (not exposed)',
            }));
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', content: `getSkills failed: ${err.message}` }));
          }
          break;
        }

        case 'getStatus': {
          const key = sessionKey(sessionName, req.cwd || undefined);
          const session = sessionManager.sessions.get(key);
          const lifecycleState = session ? (session.closed ? 'stopped' : 'running') : 'stopped';
          ws.send(JSON.stringify({
            type: 'status',
            session: sessionName,
            cwd: req.cwd || cwd || process.cwd(),
            sessionId: session?.sessionId || null,
            lifecycleState,
            isActive: session ? !session.closed : false,
            queueLength: session?.queue?.length || 0,
            processing: session?.processing || false,
            model: session?.sdkOptions?.model || null,
          }));
          break;
        }

        case 'closeSession': {
          if (req.cwd) {
            const key = `${sessionName}:${req.cwd}`;
            await sessionManager.destroy(key, 'client request', { keepHistory: true });
            ws.send(JSON.stringify({ type: 'session_closed', session: sessionName, cwd: req.cwd }));
          } else {
            await sessionManager.destroyByName(sessionName, { keepHistory: true });
            ws.send(JSON.stringify({ type: 'session_closed', session: sessionName }));
          }
          break;
        }

        case 'listSessions': {
          // 合并：内存中活跃 session + 磁盘上历史 session
          const activeByKey = new Map();
          for (const [key, s] of sessionManager.sessions) {
            if (s.closed) continue;
            activeByKey.set(key, {
              key,
              name: s.name,
              cwd: s.cwd,
              sessionId: s.sessionId,
              model: s.sdkOptions?.model,
              queueLength: s.queue.length,
              processing: s.processing,
              lifecycleState: 'active',
              startedAt: s.existingState?.startedAt,
              updatedAt: s.existingState?.updatedAt,
            });
          }

          const historical = [];
          for (const { name, cwd, state } of listStates()) {
            if (!state || !cwd) continue;
            const key = `${name}:${cwd}`;
            if (activeByKey.has(key)) continue;
            historical.push({
              key,
              name,
              cwd,
              sessionId: state.sessionId,
              model: state.model,
              queueLength: 0,
              processing: false,
              lifecycleState: state.lifecycleState || 'closed',
              startedAt: state.startedAt,
              updatedAt: state.updatedAt,
            });
          }

          ws.send(JSON.stringify({
            type: 'session_list',
            sessions: [...activeByKey.values(), ...historical],
          }));
          break;
        }

        default:
          ws.send(JSON.stringify({ type: 'error', content: `unknown type: ${req.type}` }));
      }
    });

    // 客户端断开 → 清理引用
    ws.on('close', () => {
      for (const [sKey, session] of sessionManager.sessions) {
        if (session.client === ws) {
          session.client = null;
        }
        sessionManager.removeClientFromQueue(session, ws);

        if (session.client === null && session.queue.length === 0 && !session.closed) {
          sessionManager._scheduleIdleCleanup(sKey);
        }
      }
    });
  });

  // =================================================================
  // 信号处理（优雅关闭）
  // =================================================================

  async function shutdown() {
    writeState(name, {
      ...readState(name),
      lifecycleState: LifecycleState.STOPPED,
    });

    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.close(1001, 'server shutting down');
      }
    });
    wss.close();

    await sessionManager.destroyAll('shutdown');
    deleteState(name);

    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const info = { port, name };
  console.error(`nx-ce serve ws://127.0.0.1:${port} [${name}]`);

  return info;
}
