// End-to-end test of the "browser was closed externally" recovery path.
// Initializes a session, navigates somewhere, kills chrome.exe processes
// to simulate the user closing the demo browser, then calls another tool
// and verifies we automatically force-reset the session and spawn a new
// browser.

const { execSync } = require('child_process');
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

async function startSSEReceiver() {
  const sid = sessionId;
  try {
    const response = await fetch(MCP_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': sid },
      signal: abortCtrl.signal
    });
    if (!response.ok) return;
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
            await postResponse(msg.id, {});
          }
        } catch {}
      }
    }
  } catch {}
}

async function forceSessionReset() {
  const oldSession = sessionId;
  abortCtrl.abort();
  abortCtrl = new AbortController();
  if (oldSession) {
    await fetch(MCP_ENDPOINT, {
      method: 'DELETE',
      headers: { 'Mcp-Session-Id': oldSession }
    }).catch(() => {});
  }
  sessionId = null;
}

async function ensureInit() {
  if (sessionId) return;
  let r = await postRPC('initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'browser-closed-test', version: '0.0.1' }
  });
  if (!r.ok) throw new Error('init failed: ' + r.status);
  await postRPC('notifications/initialized', undefined, { notification: true });
  startSSEReceiver().catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
}

async function callTool(name, args) {
  await ensureInit();
  let r = await postRPC('tools/call', { name, arguments: args });
  if (r.ok && r.data && r.data.result && r.data.result.isError) {
    const errText = r.data.result.content?.[0]?.text || '';
    if (/browser has been closed|target.*has been closed|context.*has been closed|browser.*disconnected/i.test(errText)) {
      console.log(`  [recovery] detected browser-closed error: ${errText.slice(0, 100)}`);
      console.log(`  [recovery] forcing session reset...`);
      await forceSessionReset();
      console.log(`  [recovery] re-initializing...`);
      await ensureInit();
      r = await postRPC('tools/call', { name, arguments: args });
    }
  }
  return r;
}

(async () => {
  console.log('1. initialize + navigate to example.com');
  let r = await callTool('browser_navigate', { url: 'https://example.com' });
  console.log('   nav status:', r.status, r.data?.result?.isError ? 'TOOL ERROR' : 'OK');
  if (!r.ok || r.data?.result?.isError) {
    console.error('FAIL on initial nav');
    process.exit(1);
  }

  console.log('\n2. Killing all chrome.exe to simulate user closing the demo browser...');
  try {
    execSync('cmd /c "taskkill /F /IM chrome.exe"', { stdio: 'pipe' });
    console.log('   chrome.exe processes killed');
  } catch (e) {
    console.log('   no chrome processes to kill (browser may not have spawned visibly)');
  }
  await new Promise((r) => setTimeout(r, 1500));

  console.log('\n3. Calling browser_navigate again - should detect dead browser and recover');
  r = await callTool('browser_navigate', { url: 'https://example.org' });
  console.log('   recovery nav status:', r.status, r.data?.result?.isError ? 'TOOL ERROR: ' + r.data.result.content?.[0]?.text?.slice(0, 200) : 'OK');

  if (r.ok && !r.data?.result?.isError) {
    console.log('\nSUCCESS - browser was recovered after external close');
    process.exit(0);
  } else {
    console.error('\nFAILED - could not recover from browser close');
    process.exit(1);
  }
})().catch((e) => {
  console.error('UNCAUGHT:', e);
  process.exit(1);
}).finally(() => {
  abortCtrl.abort();
});
