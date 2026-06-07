/**
 * nx-ce serve 集成测试
 *
 * 用法：
 *   终端1: node bin/nx-ce.js serve --port 43720
 *   终端2: node test/serve-test.mjs
 */

import WebSocket from 'ws';

const PORT = 43720;
const URL = `ws://127.0.0.1:${PORT}`;

let totalPassed = 0;
let totalFailed = 0;

function client() {
  const ws = new WebSocket(URL);
  const buf = [];
  ws.on('message', (data) => { buf.push(JSON.parse(data.toString())); });

  async function waitFor(type, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const idx = buf.findIndex(m => m.type === type);
      if (idx !== -1) return buf.splice(idx, 1)[0];
      await sleep(50);
    }
    throw new Error(`wait "${type}" timeout`);
  }

  async function waitAny(types, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const idx = buf.findIndex(m => types.includes(m.type));
      if (idx !== -1) return buf.splice(idx, 1)[0];
      await sleep(50);
    }
    throw new Error(`wait [${types}] timeout`);
  }

  async function collectText(timeout = 60000) {
    let text = '';
    while (true) {
      const m = await waitAny(['text', 'done', 'error'], timeout);
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

async function check(pass, msg) {
  if (pass) { totalPassed++; console.log(`  [PASS] ${msg}`); }
  else { totalFailed++; console.log(`  [FAIL] ${msg}`); }
}

async function section(name, fn) {
  console.log(`\n--- ${name} ---`);
  try { await fn(); } catch (e) { totalFailed++; console.log(`  [FAIL] ${e.message}`); }
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

console.log(`\n========================================`);
console.log(`  PASS: ${totalPassed}  FAIL: ${totalFailed}`);
if (totalFailed > 0) process.exit(1);
