// Smoke test for the runtime flow repairer. Uses the live MCP server to get a
// real snapshot of example.com, then feeds the repairer a fake "click failed"
// scenario and verifies it returns corrected steps using elements from the
// actual accessibility tree.

require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const { repairFlow } = require('./src/renderer/utils/flowRepairer');

// We need a real snapshot from the live browser.
const MCP_ENDPOINT = 'http://localhost:8931/mcp';
let sessionId = null;

function parseSSEPayload(text) {
  if (!text) return null;
  for (const line of text.split(/\r?\n/)) {
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
  if (response.status === 202) return null;
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const text = await response.text();
  const ct = response.headers.get('content-type') || '';
  return ct.includes('text/event-stream') ? parseSSEPayload(text) : JSON.parse(text);
}

(async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('FAIL: no GEMINI_API_KEY'); process.exit(1); }

  // 1. Get a real page into the browser
  console.log('1. Init + navigate to example.com...');
  await postRPC('initialize', {
    protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'repairer-smoke', version: '0.0.1' }
  });
  await postRPC('notifications/initialized', undefined, { notification: true });
  await postRPC('tools/call', { name: 'browser_navigate', arguments: { url: 'https://example.com' } });

  // 2. Take snapshot
  console.log('2. Taking snapshot...');
  const snapResult = await postRPC('tools/call', { name: 'browser_snapshot', arguments: {} });
  const snapshot = snapResult?.result?.content?.[0]?.text || '';
  console.log('   snapshot length:', snapshot.length, 'chars');
  console.log('   first 200:', JSON.stringify(snapshot.slice(0, 200)));

  // 3. Feed the repairer a fake "failed click" scenario
  console.log('\n3. Calling repairFlow...');
  const failedStep = {
    tool: 'browser_click',
    params: { selectors: ['#nonexistent-button'] },
    narration: 'Now we will interact with the main action button.'
  };
  const remainingSteps = [
    failedStep,
    {
      tool: 'browser_click',
      params: { selectors: ['aria/Learn more'] },
      narration: 'And here we navigate to learn more about the domain.'
    }
  ];

  const t0 = Date.now();
  let repaired;
  try {
    repaired = await repairFlow({
      snapshot: snapshot.slice(0, 4000),
      failedStep,
      error: 'MCP_TOOL_ERROR: Element not found in: ["#nonexistent-button"]',
      remainingSteps,
      flowName: 'example.com demo',
      apiKey
    });
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`   OK in ${elapsed}s`);
  console.log(`   repaired steps: ${repaired.length}`);
  console.log('');

  for (let i = 0; i < repaired.length; i++) {
    const s = repaired[i];
    const param = s.params.url || s.params.selectors?.[0] || s.params.key || s.params.text || '';
    console.log(`   ${i + 1}. ${s.tool.padEnd(22)} ${(param || '').slice(0, 60)}`);
    console.log(`      narration: ${s.narration}`);
  }

  const allNarrated = repaired.every(s => s.narration && s.narration.trim());
  console.log('\nCHECKS:');
  console.log('  has steps:', repaired.length > 0 ? 'OK' : 'FAIL');
  console.log('  all narrated:', allNarrated ? 'OK' : 'FAIL');
  console.log('  completed in <15s:', parseFloat(elapsed) < 15 ? 'OK' : 'FAIL');

  if (repaired.length === 0 || !allNarrated || parseFloat(elapsed) >= 15) {
    process.exit(1);
  }
  console.log('\nALL CHECKS PASSED');
})().catch(e => { console.error('UNCAUGHT:', e); process.exit(1); });
