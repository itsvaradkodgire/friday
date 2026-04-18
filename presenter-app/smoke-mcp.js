// Smoke test for the MCP transport + transform layer.
// Mirrors the logic in useMCPClient.js postRPC + ensureInitialized + callMCPTool
// but runs from plain Node so we can verify against the live server before
// touching the Electron renderer.

const { transformToolCall } = require('./src/renderer/hooks/useMCPClient.js');

const MCP_ENDPOINT = 'http://localhost:8931/mcp';
let sessionId = null;

function parseSSEPayload(text) {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('data: ')) return JSON.parse(line.slice(6));
  }
  throw new Error('No SSE data frame in response. Raw body: ' + JSON.stringify(text));
}

async function postRPC(method, params, opts = {}) {
  const rpc = { jsonrpc: '2.0', method };
  if (!opts.notification) rpc.id = Date.now();
  if (params !== undefined) rpc.params = params;

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream'
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const response = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(rpc)
  });

  const sid = response.headers.get('mcp-session-id');
  if (sid) sessionId = sid;

  if (response.status === 202) return null;
  if (!response.ok) throw new Error('HTTP ' + response.status);

  const text = await response.text();
  const ct = response.headers.get('content-type') || '';
  return ct.includes('text/event-stream') ? parseSSEPayload(text) : JSON.parse(text);
}

async function ensureInitialized() {
  if (sessionId) return;
  const r = await postRPC('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.1' }
  });
  if (!r || r.error) throw new Error('init failed: ' + JSON.stringify(r && r.error));
  await postRPC('notifications/initialized', undefined, { notification: true });
}

async function callTool(toolName, params) {
  await ensureInitialized();
  const transformed = transformToolCall(toolName, params || {});
  const r = await postRPC('tools/call', transformed);
  if (r && r.error) throw new Error('PROTOCOL: ' + r.error.message);
  if (r && r.result && r.result.isError) {
    throw new Error('TOOL: ' + (r.result.content?.[0]?.text ?? 'unknown'));
  }
  return r && r.result;
}

(async () => {
  console.log('1. handshake...');
  await ensureInitialized();
  console.log('   session id:', sessionId);

  console.log('2. tools/list...');
  const list = await postRPC('tools/list', {});
  console.log('   tools:', list.result.tools.length);

  console.log('3. browser_navigate -> example.com...');
  const nav = await callTool('browser_navigate', { url: 'https://example.com' });
  console.log('   ok:', !!nav, 'isError:', nav?.isError);

  console.log('4. browser_wait_for body (selector poll)...');
  const wait = await callTool('browser_wait_for', { selector: 'body', timeout: 5000 });
  console.log('   ok:', !!wait);

  console.log('5. browser_evaluate document.title...');
  const title = await callTool('browser_evaluate', {
    expression: 'return document.title;'
  });
  console.log('   raw content:', JSON.stringify(title?.content, null, 2));

  console.log('6. browser_click h1...');
  try {
    const click = await callTool('browser_click', { selector: 'h1' });
    console.log('   ok:', !!click);
  } catch (e) {
    console.log('   click err (acceptable for h1):', e.message);
  }

  console.log('6b. browser_click text/Learn more... (pseudo-selector)...');
  try {
    const click = await callTool('browser_click', { selector: 'text/Learn more' });
    console.log('   ok:', !!click);
  } catch (e) {
    console.log('   text/ resolver err:', e.message);
  }

  console.log('6c. browser_navigate back to example.com (text/ click may have navigated)...');
  await callTool('browser_navigate', { url: 'https://example.com' });
  await callTool('browser_wait_for', { selector: 'body', timeout: 5000 });

  console.log('6d. browser_click aria/Learn more... (pseudo-selector)...');
  try {
    const click = await callTool('browser_click', { selector: 'aria/Learn more' });
    console.log('   ok:', !!click);
  } catch (e) {
    console.log('   aria/ resolver err:', e.message);
  }

  console.log('6e. browser_navigate back to example.com again...');
  await callTool('browser_navigate', { url: 'https://example.com' });
  await callTool('browser_wait_for', { selector: 'body', timeout: 5000 });

  console.log('7. browser_scroll 0,200...');
  const scroll = await callTool('browser_scroll', { x: 0, y: 200 });
  console.log('   ok:', !!scroll);

  console.log('8. browser_take_screenshot...');
  const shot = await callTool('browser_screenshot', {});
  const types = (shot?.content || []).map(c => c.type);
  console.log('   content types:', types);

  console.log('9. browser_snapshot first 200 chars...');
  const snap = await callTool('browser_snapshot', {});
  const snapText = snap?.content?.[0]?.text || '';
  console.log('   snap[0:200]:', JSON.stringify(snapText.slice(0, 200)));

  console.log('\nALL OK');
})().catch((e) => {
  console.error('FAIL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
