// JSON-RPC 2.0 client for the local Playwright MCP server.
// All browser actions go through callMCPTool. Three failure modes are surfaced
// distinctly so callers (and middleman) can react: NETWORK, PROTOCOL, TOOL.
//
// Transport notes (deviation from info.md spec):
// @playwright/mcp@0.0.70 speaks the MCP Streamable HTTP transport at /mcp:
//   - Requires Accept: application/json, text/event-stream
//   - Requires an initialize handshake that returns an Mcp-Session-Id header
//   - Requires a notifications/initialized follow-up before any tools/* call
//   - Returns responses as SSE frames (event: message\ndata: {...})
//   - Every subsequent call must echo Mcp-Session-Id back
//
// Tool surface notes (deviation from info.md spec):
// The real server uses a snapshot+ref model and does NOT accept CSS selectors
// on browser_click / browser_type / browser_hover / browser_wait_for, and has
// no browser_scroll at all. To keep convertDevToolsFlow.js, flows.json, and
// executeFlowAsync untouched, we translate every selector-based tool call into
// a browser_evaluate({ function }) call right before sending it. The rest of
// the app still uses the spec's tool names with the spec's selector-shaped
// params; the translation layer is confined to transformToolCall below.

const { useEffect, useRef, useState, useCallback } = require('react');

const MCP_BASE_URL =
  (typeof process !== 'undefined' && process.env && process.env.MCP_SERVER_URL) ||
  'http://localhost:8931';
const MCP_ENDPOINT = MCP_BASE_URL.replace(/\/$/, '') + '/mcp';

// ---------------------------------------------------------------------------
// Tool call translation layer.
// Maps the spec's selector-based tool surface onto what the real server exposes.
// Returns { name, arguments } in the shape tools/call expects.
// ---------------------------------------------------------------------------

// Inlined into every generated browser_evaluate function. Resolves a list of
// "selectors" - each entry can be real CSS or a Chrome DevTools Recorder pseudo
// selector:
//   aria/<accessible name>     -> walk DOM looking for matching aria-label /
//                                 placeholder / title / value / textContent
//   text/<visible text>        -> walk leaf nodes for matching textContent
//   pierce/<css>               -> drop the prefix, retry as CSS
//   xpath/<expr>, xpath=<expr> -> document.evaluate
// Real CSS is tried first inside __resolveOne so good selectors always work
// even if the entry has a pseudo-prefix shape. __resolve iterates the list and
// returns the first element it finds - this is what makes pages with dynamic
// IDs work, since the stable aria/ entry kicks in when the per-session #id misses.
const RESOLVER_JS = `const __resolveOne = (sel) => {
  if (!sel) return null;
  // 1. Try as CSS first - real selectors win.
  try { const r = document.querySelector(sel); if (r) return r; } catch (e) {}
  // 2. aria/<accessible name>
  if (sel.startsWith('aria/')) {
    const t = sel.slice(5);
    const tryAttr = (a) => { try { return document.querySelector('[' + a + '=' + JSON.stringify(t) + ']'); } catch (e) { return null; } };
    let r = tryAttr('aria-label'); if (r) return r;
    r = tryAttr('placeholder'); if (r) return r;
    r = tryAttr('title'); if (r) return r;
    const all = document.querySelectorAll('a,button,input,select,textarea,[role],h1,h2,h3,h4,h5,h6,li,span,div,label');
    for (const el of all) {
      const name = ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title'))) || el.value || el.innerText || el.textContent || '').trim();
      if (name === t) return el;
    }
    for (const el of all) {
      const name = ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title'))) || el.value || el.innerText || el.textContent || '').trim();
      if (name && (name.startsWith(t) || t.startsWith(name))) return el;
    }
    return null;
  }
  // 3. text/<visible text>
  if (sel.startsWith('text/')) {
    const t = sel.slice(5);
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (el.children.length === 0 && (el.textContent || '').trim() === t) return el;
    }
    for (const el of all) {
      if (el.children.length === 0 && (el.textContent || '').trim().includes(t)) return el;
    }
    return null;
  }
  // 4. pierce/<css>
  if (sel.startsWith('pierce/')) {
    try { return document.querySelector(sel.slice(7)); } catch (e) { return null; }
  }
  // 5. xpath/<expr> or xpath=<expr>
  if (sel.startsWith('xpath/') || sel.startsWith('xpath=')) {
    const expr = sel.slice(6);
    try {
      const r = document.evaluate(expr, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return r.singleNodeValue;
    } catch (e) { return null; }
  }
  return null;
};
const __resolve = (selectors) => {
  if (!selectors) return null;
  const list = Array.isArray(selectors) ? selectors : [selectors];
  for (const s of list) {
    const r = __resolveOne(s);
    if (r) return r;
  }
  return null;
};`;

// Reads either the new array shape (params.selectors) or the legacy single
// string shape (params.selector). Used by every selector-bearing transform.
function getSelectors(params) {
  if (Array.isArray(params.selectors)) return params.selectors;
  if (typeof params.selector === 'string' && params.selector.length > 0) return [params.selector];
  return [];
}

// Wraps a body of statements that reference __resolve / sel into a function
// browser_evaluate accepts.
function wrapWithResolver(body) {
  return `() => { ${RESOLVER_JS} ${body} }`;
}
function wrapWithResolverAsync(body) {
  return `async () => { ${RESOLVER_JS} ${body} }`;
}

function transformToolCall(toolName, params = {}) {
  switch (toolName) {
    case 'browser_navigate':
      return { name: 'browser_navigate', arguments: { url: params.url } };

    case 'browser_press_key':
      return { name: 'browser_press_key', arguments: { key: params.key } };

    case 'browser_snapshot':
      return { name: 'browser_snapshot', arguments: {} };

    case 'browser_click': {
      const sels = getSelectors(params);
      const isDouble = params.clickCount === 2;
      // Highlight the target element briefly BEFORE the click fires so the
      // audience can see what is about to be interacted with. The outline is
      // restored after the click so the post-click visual matches what the
      // user would see in a manual demo.
      const clickAction = isDouble
        ? `el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));`
        : `el.click();`;
      const body = `const sels = ${JSON.stringify(sels)}; const el = __resolve(sels); if (!el) throw new Error('Element not found in: ' + JSON.stringify(sels)); el.scrollIntoView({ block: 'center' }); const __orig = { outline: el.style.outline, offset: el.style.outlineOffset }; el.style.outline = '3px solid #ff4444'; el.style.outlineOffset = '2px'; await new Promise(r => setTimeout(r, 500)); ${clickAction} setTimeout(() => { el.style.outline = __orig.outline; el.style.outlineOffset = __orig.offset; }, 400);`;
      return { name: 'browser_evaluate', arguments: { function: wrapWithResolverAsync(body) } };
    }

    case 'browser_type': {
      const sels = getSelectors(params);
      const text = params.text != null ? String(params.text) : '';
      const body = `const sels = ${JSON.stringify(sels)}; const el = __resolve(sels); if (!el) throw new Error('Element not found in: ' + JSON.stringify(sels)); el.focus(); const proto = Object.getPrototypeOf(el); const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set; if (setter) setter.call(el, ${JSON.stringify(text)}); else el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));`;
      return { name: 'browser_evaluate', arguments: { function: wrapWithResolver(body) } };
    }

    case 'browser_hover': {
      const sels = getSelectors(params);
      const body = `const sels = ${JSON.stringify(sels)}; const el = __resolve(sels); if (!el) throw new Error('Element not found in: ' + JSON.stringify(sels)); ['mouseover','mouseenter','mousemove'].forEach(t => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })));`;
      return { name: 'browser_evaluate', arguments: { function: wrapWithResolver(body) } };
    }

    case 'browser_scroll': {
      const x = Number(params.x) || 0;
      const y = Number(params.y) || 0;
      const fn = `() => { window.scrollTo({ left: ${x}, top: ${y}, behavior: 'smooth' }); }`;
      return { name: 'browser_evaluate', arguments: { function: fn } };
    }

    case 'browser_wait_for': {
      const sels = getSelectors(params);
      const fallbackSels = sels.length > 0 ? sels : ['body'];
      const timeout = Number(params.timeout) || 5000;
      const body = `const sels = ${JSON.stringify(fallbackSels)}; const deadline = Date.now() + ${timeout}; while (Date.now() < deadline) { if (__resolve(sels)) return true; await new Promise(r => setTimeout(r, 100)); } throw new Error('Timeout waiting for: ' + JSON.stringify(sels));`;
      return { name: 'browser_evaluate', arguments: { function: wrapWithResolverAsync(body) } };
    }

    case 'browser_screenshot':
      // Spec name -> real name
      return { name: 'browser_take_screenshot', arguments: { type: 'png' } };

    case 'browser_take_screenshot':
      return {
        name: 'browser_take_screenshot',
        arguments: { type: 'png', ...params }
      };

    case 'browser_evaluate': {
      // Real server takes { function: "() => { ... }" }, not { expression: "..." }.
      if (params.function) {
        return { name: 'browser_evaluate', arguments: { function: params.function } };
      }
      if (params.expression) {
        const wrapped = `() => { ${params.expression} }`;
        return { name: 'browser_evaluate', arguments: { function: wrapped } };
      }
      return { name: 'browser_evaluate', arguments: params };
    }

    default:
      // Pass-through for tools we don't translate (browser_close, etc.)
      return { name: toolName, arguments: params };
  }
}

// Parse the first JSON payload out of an SSE response body. Returns null when
// the body has no data frames - the MCP server occasionally answers a tools/call
// with an empty event-stream (typically when the response is delivered over a
// separate channel or when the server short-circuits a no-op call). Treating
// that as null lets the caller decide whether it's a soft success or a real
// failure, instead of blowing up the whole flow.
function parseSSEPayload(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      return JSON.parse(line.slice(6));
    }
  }
  return null;
}

function useMCPClient() {
  const [connected, setConnected] = useState(false);
  const [availableTools, setAvailableTools] = useState([]);

  const sessionIdRef = useRef(null);
  const initializedRef = useRef(false);
  const checkingRef = useRef(false);
  const healthIntervalRef = useRef(null);
  const retryTimerRef = useRef(null);
  // Long-poll receiver for server-initiated SSE messages. The MCP server's
  // heartbeat fires server.ping() requests every ~3 seconds and CLOSES our
  // session if those pings aren't answered within ~5 seconds. The pings are
  // sent over a GET /mcp SSE stream that the client must keep open. Without
  // this, our session dies after the first ~8 seconds, the next call returns
  // 404, we silently re-initialize, and the MCP server tears down the
  // browser context for the disposed session and spawns a new one - which is
  // what the user sees as "browser closing and reopening".
  const sseAbortRef = useRef(null);
  const sseRunningRef = useRef(false);

  // ----- low-level RPC over Streamable HTTP -----
  const postRPC = useCallback(async (method, params, options = {}) => {
    const rpc = { jsonrpc: '2.0', method };
    if (!options.notification) rpc.id = Date.now();
    if (params !== undefined) rpc.params = params;

    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    };
    if (sessionIdRef.current) headers['Mcp-Session-Id'] = sessionIdRef.current;

    const response = await fetch(MCP_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(rpc),
      signal: AbortSignal.timeout(10000)
    });

    // Capture session id (initialize response carries it).
    const sid = response.headers.get('mcp-session-id');
    if (sid) sessionIdRef.current = sid;

    // 202 Accepted: notifications produce no body.
    if (response.status === 202) return null;

    // 404 with a session header set means the server has forgotten our session
    // (timeout, restart, etc.). Clear it locally and surface a recognizable
    // error so callMCPTool can re-init and retry once.
    if (response.status === 404 && sessionIdRef.current) {
      sessionIdRef.current = null;
      initializedRef.current = false;
      throw new Error('STALE_SESSION');
    }

    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }

    const text = await response.text();
    const ct = response.headers.get('content-type') || '';

    if (ct.includes('text/event-stream')) {
      return parseSSEPayload(text);
    }
    return JSON.parse(text);
  }, []);

  // POST a JSON-RPC RESPONSE (not a request) back to the server. Used to
  // answer ping requests received over the SSE long-poll. Different shape
  // from postRPC: this carries an `id` + `result` (no `method`).
  const postResponse = useCallback(async (id, result) => {
    if (!sessionIdRef.current) return;
    try {
      await fetch(MCP_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Mcp-Session-Id': sessionIdRef.current
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, result }),
        signal: AbortSignal.timeout(5000)
      });
    } catch (err) {
      // If the response post fails, the heartbeat will kill the session and
      // the main code path will recover via STALE_SESSION on the next call.
      console.warn('postResponse failed:', err.message);
    }
  }, []);

  // Long-poll GET /mcp that reads server-initiated SSE messages and answers
  // ping requests so the heartbeat doesn't kill our session. Self-restarts
  // on connection drops. Bound to the current session id - when ensureInitialized
  // creates a new session it aborts the old receiver and starts a new one.
  const startSSEReceiver = useCallback(() => {
    if (sseRunningRef.current) return;
    if (!sessionIdRef.current) return;
    sseRunningRef.current = true;

    const ctrl = new AbortController();
    sseAbortRef.current = ctrl;
    const boundSessionId = sessionIdRef.current;

    (async () => {
      try {
        while (!ctrl.signal.aborted && sessionIdRef.current === boundSessionId) {
          let response;
          try {
            response = await fetch(MCP_ENDPOINT, {
              method: 'GET',
              headers: {
                Accept: 'text/event-stream',
                'Mcp-Session-Id': boundSessionId
              },
              signal: ctrl.signal
            });
          } catch (err) {
            if (ctrl.signal.aborted) break;
            // Network blip - back off and retry the GET.
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }

          if (response.status === 404) {
            // Session is gone server-side. Clear local state so the next
            // tools/call triggers a fresh initialize via STALE_SESSION.
            if (sessionIdRef.current === boundSessionId) {
              sessionIdRef.current = null;
              initializedRef.current = false;
            }
            break;
          }
          if (!response.ok) {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }

          try {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (!ctrl.signal.aborted) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });

              // SSE events are separated by a blank line.
              let idx;
              while ((idx = buffer.indexOf('\n\n')) >= 0) {
                const event = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                const dataLine = event.split('\n').find((l) => l.startsWith('data: '));
                if (!dataLine) continue;
                let msg;
                try { msg = JSON.parse(dataLine.slice(6)); }
                catch { continue; }
                // Answer pings so the heartbeat sees us.
                if (msg && msg.method === 'ping' && msg.id !== undefined) {
                  postResponse(msg.id, {});
                }
                // Other server-initiated requests/notifications could be
                // handled here in the future.
              }
            }
          } catch (err) {
            // Stream ended or aborted - outer loop reconnects if appropriate.
          }
        }
      } finally {
        sseRunningRef.current = false;
        if (sseAbortRef.current === ctrl) sseAbortRef.current = null;
      }
    })();
  }, [postResponse]);

  // Force a full session teardown and start fresh. Used when the demo browser
  // window has been closed by hand - the MCP server's `sharedBrowser` reference
  // is dead, and only a fresh `create` with clientCount===0 will respawn it.
  // Sending DELETE /mcp triggers the server's transport.onclose handler, which
  // calls disposeBackend → factory.disposed → clientCount-- → if it drops to 0,
  // sharedBrowser is set to undefined. The next initialize then spawns a new
  // browser. See @playwright/mcp .../program.js create/disposed callbacks.
  const forceSessionReset = useCallback(async () => {
    const oldSession = sessionIdRef.current;
    if (sseAbortRef.current) {
      sseAbortRef.current.abort();
      sseAbortRef.current = null;
      sseRunningRef.current = false;
    }
    if (oldSession) {
      try {
        await fetch(MCP_ENDPOINT, {
          method: 'DELETE',
          headers: { 'Mcp-Session-Id': oldSession },
          signal: AbortSignal.timeout(5000)
        });
      } catch {
        // Ignore - we're tearing down regardless.
      }
    }
    sessionIdRef.current = null;
    initializedRef.current = false;
  }, []);

  // ----- initialize handshake (idempotent) -----
  const ensureInitialized = useCallback(async () => {
    if (sessionIdRef.current && initializedRef.current) return;

    // Abort any previous SSE receiver tied to a stale session.
    if (sseAbortRef.current) {
      sseAbortRef.current.abort();
      sseAbortRef.current = null;
      sseRunningRef.current = false;
    }

    const initResp = await postRPC('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'ai-demo-presenter', version: '0.1.0' }
    });
    if (!initResp || initResp.error) {
      const msg = initResp && initResp.error ? initResp.error.message : 'no response';
      throw new Error('initialize failed: ' + msg);
    }
    await postRPC('notifications/initialized', undefined, { notification: true });
    initializedRef.current = true;

    // Open the GET SSE long-poll BEFORE returning, so the very first tools/call
    // (which triggers the server's lazy heartbeat) has a place to deliver pings.
    startSSEReceiver();
  }, [postRPC, startSSEReceiver]);

  // ----- base tool call -----
  const callMCPTool = useCallback(
    async (toolName, params) => {
      const transformed = transformToolCall(toolName, params || {});

      // Helper: send the call once. Throws on network/HTTP errors. Returns the
      // raw JSON-RPC response object (or null when the SSE body was empty).
      const attempt = async () => {
        await ensureInitialized();
        return postRPC('tools/call', transformed);
      };

      let data;
      let attemptedReinit = false;
      try {
        data = await attempt();
      } catch (err) {
        // STALE_SESSION = the server forgot our session. postRPC has already
        // cleared sessionIdRef + initializedRef, so the next attempt() will
        // negotiate a fresh handshake. Retry exactly once.
        if (err.message === 'STALE_SESSION') {
          attemptedReinit = true;
          try {
            data = await attempt();
            setConnected(true);
          } catch (err2) {
            setConnected(false);
            throw new Error('MCP_NETWORK_ERROR: ' + err2.message);
          }
        } else {
          setConnected(false);
          throw new Error('MCP_NETWORK_ERROR: ' + err.message);
        }
      }

      // Server returned 200 + empty SSE body. Treat as a soft no-result success
      // - the tool didn't error, we just have no payload to inspect. The flow
      // engine will move on to the next step instead of halting.
      if (data == null) {
        if (attemptedReinit) setConnected(true);
        return null;
      }

      // Failure mode 2: protocol error.
      if (data.error) {
        // Some servers report stale-session as a JSON-RPC error rather than 404.
        // Same recovery path: clear, re-init, retry once.
        if (/session/i.test(data.error.message || '') && !attemptedReinit) {
          sessionIdRef.current = null;
          initializedRef.current = false;
          try {
            data = await attempt();
            setConnected(true);
          } catch (err) {
            setConnected(false);
            throw new Error('MCP_NETWORK_ERROR: ' + err.message);
          }
          if (data && data.error) {
            throw new Error('MCP_PROTOCOL_ERROR: ' + data.error.message);
          }
          if (data == null) return null;
        } else {
          throw new Error('MCP_PROTOCOL_ERROR: ' + data.error.message);
        }
      }

      // Failure mode 3: tool reported failure.
      if (data.result && data.result.isError) {
        const errText = data.result.content?.[0]?.text ?? 'unknown error';

        // Special case: the demo browser window was closed externally (the
        // user hit the X button, the OS killed the process, etc). The MCP
        // server's session is still alive, but its sharedBrowser handle is
        // dead. Re-initializing alone won't help because clientCount is still
        // 1 - we need to fully DELETE the session so disposed fires and
        // sharedBrowser gets cleared. Then a fresh initialize will spawn a
        // new browser.
        const browserClosedRegex = /browser has been closed|target.*has been closed|context.*has been closed|page.*has been closed|browser.*disconnected|browser closed|connection closed/i;
        if (!attemptedReinit && browserClosedRegex.test(errText)) {
          await forceSessionReset();
          attemptedReinit = true;
          try {
            data = await attempt();
            setConnected(true);
          } catch (err) {
            setConnected(false);
            throw new Error('MCP_NETWORK_ERROR: ' + err.message);
          }
          if (data == null) return null;
          if (data.error) {
            throw new Error('MCP_PROTOCOL_ERROR: ' + data.error.message);
          }
          if (data.result && data.result.isError) {
            throw new Error(
              'MCP_TOOL_ERROR: ' + (data.result.content?.[0]?.text ?? 'unknown error')
            );
          }
          return data.result;
        }

        throw new Error('MCP_TOOL_ERROR: ' + errText);
      }

      return data.result;
    },
    [ensureInitialized, forceSessionReset, postRPC]
  );

  // ----- startup connect with retry loop -----
  const connectToMCP = useCallback(async () => {
    try {
      sessionIdRef.current = null;
      initializedRef.current = false;
      await ensureInitialized();
      const data = await postRPC('tools/list', {});
      setConnected(true);
      setAvailableTools(((data && data.result && data.result.tools) || []).map((t) => t.name));
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    } catch {
      setConnected(false);
      retryTimerRef.current = setTimeout(connectToMCP, 3000); // retry every 3 seconds
    }
  }, [ensureInitialized, postRPC]);

  // ----- mount: connect once + 15s health check -----
  useEffect(() => {
    connectToMCP();

    healthIntervalRef.current = setInterval(async () => {
      if (checkingRef.current) return;
      checkingRef.current = true;
      try {
        await ensureInitialized();
        await postRPC('tools/list', {});
        setConnected(true);
      } catch {
        setConnected(false);
        connectToMCP();
      } finally {
        checkingRef.current = false;
      }
    }, 15000);

    return () => {
      if (healthIntervalRef.current) clearInterval(healthIntervalRef.current);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (sseAbortRef.current) {
        sseAbortRef.current.abort();
        sseAbortRef.current = null;
      }
      sseRunningRef.current = false;
    };
  }, [connectToMCP, ensureInitialized, postRPC]);

  return {
    connected,
    availableTools,
    callMCPTool,
    connectToMCP,
    serverUrl: MCP_ENDPOINT
  };
}

module.exports = { useMCPClient, transformToolCall };
