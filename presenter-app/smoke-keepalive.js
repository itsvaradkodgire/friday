// Verifies the SSE long-poll keep-alive: initialize a session, open the GET
// SSE stream, respond to ping requests, and prove that subsequent tools/call
// requests still work after >15 seconds (longer than the unprotected ~8s
// session timeout).
//
// If the ping responder works, T+18 should still return 200. If it doesn't,
// T+18 will be 404 just like the bare smoke-mcp.js shows today.

const MCP_ENDPOINT = 'http://localhost:8931/mcp';
let sessionId = null;
let abortCtrl = new AbortController();

function parseSSEPayload(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('data: ')) return JSON.parse(line.slice(6));
  }
  return null;
}

async function postRPC(method, params, opts = {}) {
  const rpc = { jsonrpc: '2.0', method };
  if (!opts.notification) rpc.id = Date.now();
  if (params !== undefined) rpc.params = params;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const response = await fetch(MCP_ENDPOINT, { method: 'POST', headers, body: JSON.stringify(rpc) });
  const sid = response.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  if (response.status === 202) return { ok: true, status: 202 };
  if (!response.ok) return { ok: false, status: response.status };
  const text = await response.text();
  const ct = response.headers.get('content-type') || '';
  return { ok: true, status: response.status, data: ct.includes('text/event-stream') ? parseSSEPayload(text) : JSON.parse(text) };
}

async function postResponse(id, result) {
  if (!sessionId) return;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'Mcp-Session-Id': sessionId
  };
  await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, result })
  }).catch(() => {});
}

let pingCount = 0;
async function startSSEReceiver() {
  const sid = sessionId;
  const response = await fetch(MCP_ENDPOINT, {
    method: 'GET',
    headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': sid },
    signal: abortCtrl.signal
  });
  if (!response.ok) {
    console.error('SSE GET failed:', response.status);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!abortCtrl.signal.aborted) {
    let chunk;
    try { chunk = await reader.read(); } catch { break; }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = event.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      try {
        const msg = JSON.parse(dataLine.slice(6));
        if (msg.method === 'ping' && msg.id !== undefined) {
          pingCount++;
          console.log(`  [SSE] received ping #${pingCount} (id=${msg.id}), responding...`);
          await postResponse(msg.id, {});
        }
      } catch {}
    }
  }
}

(async () => {
  console.log('1. initialize...');
  let r = await postRPC('initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'keepalive-test', version: '0.0.1' }
  });
  if (!r.ok) { console.error('FAIL init:', r.status); process.exit(1); }
  console.log('   session:', sessionId);
  await postRPC('notifications/initialized', undefined, { notification: true });

  console.log('2. starting SSE receiver in background...');
  startSSEReceiver().catch((e) => console.error('SSE error:', e.message));
  await new Promise((r) => setTimeout(r, 500));

  console.log('3. T+0 navigate to example.com...');
  r = await postRPC('tools/call', { name: 'browser_navigate', arguments: { url: 'https://example.com' } });
  console.log('   nav:', r.status, r.ok ? 'OK' : 'FAIL');

  for (const sec of [4, 9, 14, 19, 24]) {
    await new Promise((r) => setTimeout(r, sec === 4 ? 4000 : 5000));
    console.log(`4. T+${sec} tools/list...`);
    r = await postRPC('tools/list', {});
    console.log(`   ${r.status}`, r.ok ? 'OK' : `FAIL (session lost)`);
    if (!r.ok) {
      console.error('\nKEEP-ALIVE FAILED at T+' + sec);
      console.error('Pings received:', pingCount);
      abortCtrl.abort();
      process.exit(1);
    }
  }

  console.log(`\nSUCCESS - session survived >24s with ${pingCount} ping responses`);
  abortCtrl.abort();
  process.exit(0);
})().catch((e) => {
  console.error('UNCAUGHT:', e);
  process.exit(1);
});
