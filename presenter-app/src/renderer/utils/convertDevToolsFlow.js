// Pure converter: Chrome DevTools Recorder JSON -> flows.json-compatible flow object.
// No side effects. Throws on invalid input. Unknown step types are skipped with a warning.
//
// Selector handling: every step that targets an element stores the FULL ordered
// list of recorder selector strategies in `params.selectors` (array). The runtime
// resolver in useMCPClient.js tries each strategy in order until one finds an
// element on the live page - this is the only way pages with dynamic IDs
// (Google search results, hashed React class names, etc.) work reliably, since
// the stable aria/ accessible name kicks in when the per-session #id misses.

function convertDevToolsFlow(devToolsJson, overrides = {}) {
  if (!devToolsJson || typeof devToolsJson.title !== 'string' || !Array.isArray(devToolsJson.steps)) {
    throw new Error('Invalid DevTools Recorder export: missing title or steps');
  }

  const steps = [];

  for (const step of devToolsJson.steps) {
    const converted = convertStep(step);
    if (!converted) continue;

    if (Array.isArray(converted)) {
      for (const c of converted) steps.push(c);
    } else {
      steps.push(converted);
    }
  }

  const name = overrides.name || devToolsJson.title;
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return {
    id,
    name,
    description: overrides.description || '',
    source: 'devtools-recorder',
    created_at: new Date().toISOString(),
    steps
  };
}

function convertStep(step) {
  switch (step.type) {
    case 'setViewport':
      // Recorded viewport is the presenter's window at record time, NOT what
      // the audience should see. Always skip - the demo browser stays at the
      // size set by playwright-mcp.config.json. Returning null is identical
      // to the keyUp case (silent skip, no warning).
      return null;

    case 'navigate':
      // Auto-insert browser_wait_for body after every navigate. The wait uses the
      // selectors array shape so it goes through __resolve like every other step.
      return [
        { tool: 'browser_navigate', params: { url: step.url } },
        { tool: 'browser_wait_for', params: { selectors: ['body'], timeout: 5000 } }
      ];

    case 'click':
      return { tool: 'browser_click', params: { selectors: orderSelectors(step.selectors) } };

    case 'scroll':
      return { tool: 'browser_scroll', params: { x: step.x || 0, y: step.y || 0 } };

    case 'keyDown':
      return { tool: 'browser_press_key', params: { key: step.key } };

    case 'keyUp':
      // Recorder pairs keyDown+keyUp for every keystroke. browser_press_key handles
      // both phases internally, so keyUp is a known no-op (NOT an unknown step).
      // Return null to skip without tripping the default branch's warning.
      return null;

    case 'change':
      return {
        tool: 'browser_type',
        params: { selectors: orderSelectors(step.selectors), text: step.value }
      };

    case 'hover':
      return { tool: 'browser_hover', params: { selectors: orderSelectors(step.selectors) } };

    case 'waitForElement':
      return { tool: 'browser_wait_for', params: { selectors: orderSelectors(step.selectors) } };

    case 'doubleClick':
      return {
        tool: 'browser_click',
        params: { selectors: orderSelectors(step.selectors), clickCount: 2 }
      };

    default:
      console.warn(`convertDevToolsFlow: unknown step type "${step.type}", skipping`);
      return null;
  }
}

// Predicates ordered by selector stability. orderSelectors uses these to bucket
// every recorder strategy into a priority position. Anything matching no bucket
// goes last. The key change vs the old bestSelector: aria/ pseudo-selectors are
// at priority 3, ABOVE id selectors at priority 5 - because dynamic IDs from
// search results / React apps are common and an id alone is no guarantee of
// stability. The runtime resolver still tries the id second if aria misses.
const SELECTOR_PRIORITY = [
  (s) => s.includes('data-testid'),                                              // 1 data-testid CSS attribute
  (s) => s.includes('aria-label'),                                               // 2 aria-label CSS attribute
  (s) => s.startsWith('aria/'),                                                  // 3 aria/ accessible name
  (s) => /^(button|a|input):has-text/.test(s),                                   // 4 role+text combo
  (s) => s.startsWith('#'),                                                      // 5 id selector
  (s) => s.startsWith('[') || (s.includes('[') && !s.startsWith('xpath')),       // 6 attribute selector
  (s) => s.startsWith('.') || /^[a-z][a-zA-Z0-9-]*([\s.>+~]|$)/.test(s),         // 7 class/tag/descendant CSS
  (s) => s.startsWith('text/'),                                                  // 8 text/ visible-text walker
  (s) => s.startsWith('pierce/'),                                                // 9 pierce/ (top-level only without piercing support)
  (s) => s.startsWith('xpath/') || s.startsWith('xpath=')                        // 10 XPath
];

function orderSelectors(selectors) {
  if (!Array.isArray(selectors)) return [];
  // Recorder gives an array of arrays - inner arrays are technically shadow-DOM
  // descent chains, but without piercing support we treat each element as an
  // independent strategy. flat() collapses both layers.
  const flat = selectors.flat().filter((s) => typeof s === 'string' && s.length > 0);
  const seen = new Set();
  const dedup = [];
  for (const s of flat) {
    if (seen.has(s)) continue;
    seen.add(s);
    dedup.push(s);
  }
  const buckets = SELECTOR_PRIORITY.map(() => []);
  const fallback = [];
  for (const sel of dedup) {
    const idx = SELECTOR_PRIORITY.findIndex((pred) => pred(sel));
    if (idx === -1) fallback.push(sel);
    else buckets[idx].push(sel);
  }
  return [...buckets.flat(), ...fallback];
}

module.exports = { convertDevToolsFlow, orderSelectors };
