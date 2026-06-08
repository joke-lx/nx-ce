/**
 * nx-ce serve 集成测试
 *
 * 用法：
 *   终端1: node bin/nx-ce.js serve --port 43720
 *   终端2: node test/serve-test.mjs
 */

import WebSocket from 'ws';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const PORT = 43720;
const URL = `ws://127.0.0.1:${PORT}`;

// 清理已知的测试 session 状态文件，防止旧状态干扰（resume 过期会话）
const STATE_DIR = join(homedir(), '.nx-ce', 'instances');
const TEST_SESSIONS = [
  'test-single', 'sess-a', 'sess-b', 's3a', 's3b', 's3c', 'memory-test',
  'model-test', 'pm-test', 'both-test', 'status-model',
  'model-err', 'model-err2', 'pm-err',
  'pm-all-default', 'pm-all-acceptEdits', 'pm-all-bypassPermissions',
  'pm-all-plan', 'pm-all-dontAsk', 'pm-all-auto',
];
function cleanTestStates() {
  try { mkdirSync(STATE_DIR, { recursive: true }); } catch {}
  const files = readdirSync(STATE_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const name = file.slice(0, -5);
    const base = name.includes('~') ? name.split('~')[0] : name;
    if (TEST_SESSIONS.includes(base)) {
      rmSync(join(STATE_DIR, file), { force: true });
    }
  }
}
cleanTestStates();

let totalPassed = 0;
let totalFailed = 0;

function client() {
  const ws = new WebSocket(URL);
  const buf = [];
  let wsError = null;
  let wsClosed = false;
  ws.on('message', (data) => { buf.push(JSON.parse(data.toString())); });
  ws.on('error', (err) => { wsError = err; });
  ws.on('close', () => { wsClosed = true; });

  /** 在 buf 中等待指定 type 的消息，同时检测 WS 错误/关闭 */
  async function waitFor(type, timeout = DEFAULT_TIMEOUT) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (wsError) throw new Error(`WS error: ${wsError.message}`);
      if (wsClosed) throw new Error('WS closed before receiving expected message');
      const idx = buf.findIndex(m => m.type === type);
      if (idx !== -1) return buf.splice(idx, 1)[0];
      await sleep(50);
    }
    throw new Error(`wait "${type}" timeout (last msgs: ${JSON.stringify(buf.slice(-3))})`);
  }

  async function waitAny(types, timeout = DEFAULT_TIMEOUT) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (wsError) throw new Error(`WS error: ${wsError.message}`);
      if (wsClosed) throw new Error('WS closed before receiving expected message');
      const idx = buf.findIndex(m => types.includes(m.type));
      if (idx !== -1) return buf.splice(idx, 1)[0];
      await sleep(50);
    }
    throw new Error(`wait [${types}] timeout (last msgs: ${JSON.stringify(buf.slice(-3))})`);
  }

  async function collectText(timeout = DEFAULT_TIMEOUT) {
    const deadline = Date.now() + timeout;
    let text = '';
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`collectText total timeout (got so far: ${JSON.stringify(text.slice(0, 80))})`);
      const m = await waitAny(['text', 'done', 'error'], remaining);
      if (m.type === 'text') text += m.content;
      if (m.type === 'done') return { text, sessionId: m.sessionId };
      if (m.type === 'error') throw new Error(`SDK error: ${m.content}`);
    }
  }

  function send(data) { ws.send(JSON.stringify(data)); }
  function close() { ws.close(); }

  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, buf, waitFor, waitAny, collectText, send, close }));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout (is serve running?)')), 5000);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 冷启动 session 可能需要较长时间，设大默认 timeout */
const DEFAULT_TIMEOUT = 120000;

async function check(pass, msg) {
  if (pass) { totalPassed++; console.log(`  [PASS] ${msg}`); }
  else { totalFailed++; console.log(`  [FAIL] ${msg}`); }
}

async function section(name, fn) {
  console.log(`\n--- ${name} ---`);
  try { await fn(); } catch (e) { totalFailed++; console.log(`  [FAIL] ${e.message}`); }
}

// 预热 — 首次查询 SDK 冷启动较慢，先跑一次预热
// 注意：每个不同的 session name 都会触发独立的 SDK 冷启动
let warmed = false;
if (!warmed) {
  warmed = true;
  const c = await client();
  await c.waitFor('connected', 30000);
  // __warmup__ session — 让 SDK 先加载
  c.send({ type: 'query', session: '__warmup__', prompt: '只回答数字：1+1=？' });
  try {
    const r = await c.collectText(180000);
    console.log(`  warmup: ${r.text.trim()}`);
  } catch(e) { console.log(`  warmup: ${e.message}`); }
  c.close();
  // 每个并发 session 单独预热
  for (const s of ['sess-a', 'sess-b', 's3a', 's3b', 's3c', 'memory-test']) {
    const c2 = await client();
    await c2.waitFor('connected', 30000);
    c2.send({ type: 'query', session: s, prompt: '只回答数字：1+1=？' });
    try {
      await c2.collectText(180000);
      console.log(`  warmup ${s}: done`);
    } catch(e) { console.log(`  warmup ${s}: ${e.message}`); }
    c2.close();
  }
}

await section('connect', async () => {
  const c = await client();
  const msg = await c.waitFor('connected');
  await check(msg.type === 'connected', 'connected');
  c.close();
});

await section('ping/pong', async () => {
  const c = await client();
  await c.waitFor('connected');
  c.send({ type: 'ping' });
  const msg = await c.waitFor('pong');
  await check(msg.type === 'pong', 'pong');
  c.close();
});

await section('single session query', async () => {
  const c = await client();
  await c.waitFor('connected');
  c.send({ type: 'query', session: 'test-single', prompt: '用中文回答：1+1=？只回答数字' });
  const { text } = await c.collectText();
  await check(text.trim() === '2' || text.trim() === '二', `answer: ${text.trim()}`);
  c.close();
});

await section('multi-session isolation', async () => {
  const a = await client(), b = await client();
  await a.waitFor('connected'); await b.waitFor('connected');
  a.send({ type: 'query', session: 'sess-a', prompt: '只回答数字：7*8=？' });
  await sleep(100);
  b.send({ type: 'query', session: 'sess-b', prompt: '只回答单词：苹果的英文？' });
  const ra = await a.collectText();
  await check(ra.text.includes('56'), `A: ${ra.text.trim()}`);
  const rb = await b.collectText();
  await check(rb.text.toLowerCase().includes('apple'), `B: ${rb.text.trim()}`);
  a.close(); b.close();
});

await section('3 concurrent sessions', async () => {
  const cc = await Promise.all([client(), client(), client()]);
  await Promise.all(cc.map(c => c.waitFor('connected')));
  cc[0].send({ type: 'query', session: 's3a', prompt: '只回答数字：3+5=？' });
  cc[1].send({ type: 'query', session: 's3b', prompt: '只回答数字：100/4=？' });
  cc[2].send({ type: 'query', session: 's3c', prompt: '只回答单词：猫的英文？' });
  const r = await Promise.all(cc.map(c => c.collectText()));
  await check(r[0].text.trim() === '8', `3+5=8: ${r[0].text.trim()}`);
  await check(r[1].text.trim() === '25', `100/4=25: ${r[1].text.trim()}`);
  await check(r[2].text.toLowerCase().includes('cat'), `cat: ${r[2].text.trim()}`);
  cc.forEach(c => c.close());
});

await section('long conversation (resume)', async () => {
  const c1 = await client();
  await c1.waitFor('connected');
  c1.send({ type: 'query', session: 'memory-test', prompt: '记住数字：2024，不要输出' });
  await c1.collectText();
  c1.close();

  const c2 = await client();
  await c2.waitFor('connected');
  c2.send({ type: 'query', session: 'memory-test', prompt: '刚才的数字是？只回答数字' });
  const { text } = await c2.collectText();
  await check(text.includes('2024'), `remember 2024: ${text.trim()}`);
  c2.close();
});

await section('listSessions', async () => {
  const c = await client(); await c.waitFor('connected');
  c.send({ type: 'listSessions' });
  const msg = await c.waitFor('session_list');
  await check(msg.type === 'session_list', 'session_list');
  await check(Array.isArray(msg.sessions), 'array');
  c.close();
});

await section('closeSession', async () => {
  const c = await client(); await c.waitFor('connected');
  c.send({ type: 'closeSession', session: 'test-single' });
  const msg = await c.waitFor('session_closed');
  await check(msg.type === 'session_closed', 'session_closed');
  c.close();
});

await section('getSkills', async () => {
  const c = await client(); await c.waitFor('connected');
  c.send({ type: 'getSkills', session: 'default' });
  const msg = await c.waitFor('skills');
  await check(msg.type === 'skills', 'skills');
  c.close();
});

await section('getStatus', async () => {
  const c = await client(); await c.waitFor('connected');
  c.send({ type: 'getStatus', session: 'default' });
  const msg = await c.waitFor('status');
  await check(msg.type === 'status', 'status');
  c.close();
});

// ============================================================
// model & permissionMode 参数测试
// ============================================================

await section('query with model parameter', async () => {
  const c = await client(); await c.waitFor('connected');
  c.send({ type: 'query', session: 'model-test', prompt: '只回答数字：1+1=？', model: 'claude-sonnet-4-6' });
  const { text } = await c.collectText();
  await check(text.trim() === '2', `model test answer: ${text.trim()}`);
  c.close();
});

await section('query with valid permissionMode', async () => {
  const c = await client(); await c.waitFor('connected');
  c.send({ type: 'query', session: 'pm-test', prompt: '只回答数字：2+2=？', permissionMode: 'bypassPermissions' });
  const { text } = await c.collectText();
  await check(text.trim() === '4', `permissionMode test answer: ${text.trim()}`);
  c.close();
});

await section('query with both model and permissionMode', async () => {
  const c = await client(); await c.waitFor('connected');
  c.send({
    type: 'query', session: 'both-test', prompt: '只回答数字：3+4=？',
    model: 'claude-sonnet-4-6', permissionMode: 'bypassPermissions',
  });
  const { text } = await c.collectText();
  await check(text.trim() === '7', `both params answer: ${text.trim()}`);
  c.close();
});

await section('model validation: empty string', async () => {
  const c = await client(); await c.waitFor('connected');
  c.send({ type: 'query', session: 'model-err', prompt: 'hi', model: '' });
  const msg = await c.waitFor('error');
  await check(msg.content.includes('model must be a non-empty string'), `empty model: ${msg.content}`);
  c.close();
});

await section('model validation: non-string type', async () => {
  const c = await client(); await c.waitFor('connected');
  c.send({ type: 'query', session: 'model-err2', prompt: 'hi', model: 123 });
  const msg = await c.waitFor('error');
  await check(msg.content.includes('model must be a non-empty string'), `non-string model: ${msg.content}`);
  c.close();
});

await section('permissionMode validation: invalid value', async () => {
  const c = await client(); await c.waitFor('connected');
  c.send({ type: 'query', session: 'pm-err', prompt: 'hi', permissionMode: 'INVALID_MODE' });
  const msg = await c.waitFor('error');
  await check(msg.content.includes('Invalid permissionMode'), `invalid pm: ${msg.content}`);
  c.close();
});

await section('permissionMode: all valid values', async () => {
  const validModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'];
  for (const mode of validModes) {
    const c = await client(); await c.waitFor('connected');
    c.send({ type: 'query', session: `pm-all-${mode}`, prompt: '只回答数字：1+1=？', permissionMode: mode });
    const { text } = await c.collectText();
    await check(text.trim() === '2', `pm "${mode}" answer: ${text.trim()}`);
    c.close();
  }
});

await section('getStatus reflects model', async () => {
  const c = await client(); await c.waitFor('connected');
  c.send({ type: 'query', session: 'status-model', prompt: '只回答数字：1+1=？', model: 'claude-sonnet-4-6' });
  const { text } = await c.collectText();
  await check(text.trim() === '2', 'query with model ok');
  c.send({ type: 'getStatus', session: 'status-model' });
  const msg = await c.waitFor('status');
  await check(msg.model === 'claude-sonnet-4-6', `getStatus.model = ${msg.model}`);
  c.close();
});

console.log(`\n========================================`);
console.log(`  PASS: ${totalPassed}  FAIL: ${totalFailed}`);
if (totalFailed > 0) process.exit(1);
