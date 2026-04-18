// One-shot diagnostic: navigate to example.com and dump every leaf element's
// textContent so we can see what the resolver should be matching against.

const { transformToolCall } = require('./src/renderer/hooks/useMCPClient.js');
const MCP_ENDPOINT = 'http://localhost:8931/mcp';
let sessionId = null;

function parseSSEPayload(text) {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('data: ')) return JSON.parse(line.slice(6));
  }
  throw new Error('No SSE data frame in response. Raw: ' + JSON.stringify(text));
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

  if (response.status === 202) return null;
  if (!response.ok) throw new Error('HTTP ' + response.status);

  const text = await response.text();
  const ct = response.headers.get('content-type') || '';
  return ct.includes('text/event-stream') ? parseSSEPayload(text) : JSON.parse(text);
}

async function ensureInitialized() {
  if (sessionId) return;
  await postRPC('initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'debug', version: '0.0.1' }
  });
  await postRPC('notifications/initialized', undefined, { notification: true });
}

async function callTool(toolName, params) {
  await ensureInitialized();
  const transformed = transformToolCall(toolName, params || {});
  const r = await postRPC('tools/call', transformed);
  if (r && r.error) throw new Error('PROTOCOL: ' + r.error.message);
  if (r && r.result && r.result.isError) throw new Error('TOOL: ' + (r.result.content?.[0]?.text ?? 'unknown'));
  return r && r.result;
}

(async () => {
  await callTool('browser_navigate', { url: 'https://example.com' });
  await callTool('browser_wait_for', { selector: 'body', timeout: 5000 });

  // Dump every element with no children, with its tag and trimmed textContent.
  const dump = await callTool('browser_evaluate', {
    function: `() => {
      const all = document.querySelectorAll('*');
      const out = [];
      for (const el of all) {
        if (el.children.length === 0) {
          const t = (el.textContent || '').trim();
          if (t) out.push(el.tagName + ': ' + JSON.stringify(t.slice(0, 80)));
        }
      }
      return out.join('\\n');
    }`
  });
  console.log('LEAF DUMP:');
  console.log(dump?.content?.[0]?.text);

  // Now test the resolver directly
  const resolverTest = await callTool('browser_evaluate', {
    function: `() => {
      const t = 'More information';
      const all = document.querySelectorAll('*');
      let found = null;
      for (const el of all) {
        if (el.children.length === 0 && (el.textContent || '').trim().includes(t)) {
          found = el.tagName + ' ' + JSON.stringify((el.textContent || '').trim());
          break;
        }
      }
      return found || 'NO MATCH';
    }`
  });
  console.log('\\nRESOLVER TEST RESULT:');
  console.log(resolverTest?.content?.[0]?.text);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });