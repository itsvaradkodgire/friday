// AI-powered flow improver. Takes a raw Chrome DevTools Recorder export and
// produces a CLEANED, NARRATED flow ready for guided playback.
//
// Two phases:
//   1. Mechanical pre-pass: drops setViewport/keyUp and otherwise leaves the
//      raw step list alone. The AI handles the rest of the cleanup.
//   2. AI annotation: a single gemini-2.5-flash text-completion call that
//      produces a {steps:[{tool, params, narration}, ...]} JSON. Strictly
//      validated against the original recorder's URL/selector pool so the
//      AI cannot hallucinate.
//
// On any failure (no API key, network, validation), this module THROWS. The
// caller (FlowImporter) catches and falls back to the mechanical
// convertDevToolsFlow with a UI warning.

const { GoogleGenAI } = require('@google/genai');
const { convertDevToolsFlow } = require('./convertDevToolsFlow');

const IMPROVER_MODEL = 'gemini-2.5-flash';

const ALLOWED_TOOLS = new Set([
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_scroll',
  'browser_wait_for',
  'browser_hover'
]);

const VERBOSITY_GUIDANCE = {
  brief:
    '5-10 words per narration. One short sentence. No filler. Get to the point fast.',
  normal:
    '15-30 words per narration. One or two sentences. Some context but stay concise.',
  detailed:
    '40-70 words per narration. Two or three sentences. Narrative context, why this step matters, what the audience is about to see.'
};

// Normalizes whatever selector shape the AI returned into a flat array of
// strings. The AI mistakes itself in many ways:
//   - flat string array (the right answer): ["#a", "#b"]                        -> as-is
//   - nested string arrays:                  [["#a"], ["#b"]]                   -> flatten one level
//   - deeper nesting:                        [[["#a"]], ["#b", ["#c"]]]         -> recursive flatten
//   - single string:                         "#a"                               -> [#a]
//   - object map (rare):                     {0: "#a", 1: "#b"}                 -> Object.values
//   - array of objects with value field:     [{value: "#a"}, {selector: "#b"}]  -> extract field
//   - mixed garbage:                         [null, 5, "#a", undefined, "#b"]   -> drop non-strings, keep rest
// Anything that can't be coerced is silently dropped. Returns a fresh array.
function normalizeSelectors(raw) {
  if (raw == null) return [];
  if (typeof raw === 'string') return [raw];
  // Object-as-map -> values
  if (!Array.isArray(raw) && typeof raw === 'object') {
    raw = Object.values(raw);
  }
  if (!Array.isArray(raw)) return [];
  const out = [];
  const visit = (entry) => {
    if (entry == null) return;
    if (typeof entry === 'string') {
      out.push(entry);
      return;
    }
    if (Array.isArray(entry)) {
      for (const e of entry) visit(e);
      return;
    }
    if (typeof entry === 'object') {
      // Try common field names the AI might invent.
      const candidate =
        entry.selector || entry.value || entry.text || entry.css || entry.aria || entry.xpath;
      if (typeof candidate === 'string') {
        out.push(candidate);
      } else {
        // Last resort: take any string field at all.
        for (const v of Object.values(entry)) {
          if (typeof v === 'string') {
            out.push(v);
            break;
          }
        }
      }
      return;
    }
    // Numbers, booleans, etc - drop silently.
  };
  for (const entry of raw) visit(entry);
  return out;
}

// ----- mechanical pre-pass -----
// Drops the artifacts that the AI doesn't need to see and that would just
// distract its prompt budget.
function preProcessRawSteps(rawSteps) {
  const out = [];
  for (const step of rawSteps) {
    if (!step || typeof step.type !== 'string') continue;
    if (step.type === 'setViewport') continue;
    if (step.type === 'keyUp') continue;
    out.push(step);
  }
  return out;
}

// Normalizes a selector string for fuzzy comparison. Strips unicode artifacts
// the recorder leaks into selector strings:
//   - U+00C2 (Â) shows up as a mojibake artifact when the recorder serializes
//     accessible names that contain U+00A0 (non-breaking space). The AI helpfully
//     cleans these up in its output, which then fails an exact-string match
//     against the original pool.
//   - U+00A0 (NBSP) -> regular space
//   - collapse runs of whitespace
//   - trim
// The validator stores BOTH the original and the normalized form so it can
// detect "the AI cleaned this up but it's the same selector" cases and
// substitute the original (mojibake-and-all) string back into the AI's output,
// which is what the runtime resolver needs to match the live page.
function normalizeForCompare(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/\u00C2/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ----- pool extraction (for hallucination defense) -----
// Walks the raw recorder steps and collects every URL and every selector
// string the recorder ever mentioned. The AI's output must be a subset.
// selectorPool is the Set of original strings (used for exact-match check).
// selectorNormalizedToOriginal maps normalized form -> original string so we
// can recover the recorder's exact bytes when the AI cleaned them up.
function buildAllowedPools(rawSteps) {
  const urlPool = new Set();
  const selectorPool = new Set();
  const selectorNormalizedToOriginal = new Map();
  const addSelector = (s) => {
    if (typeof s !== 'string') return;
    selectorPool.add(s);
    const norm = normalizeForCompare(s);
    if (norm && !selectorNormalizedToOriginal.has(norm)) {
      selectorNormalizedToOriginal.set(norm, s);
    }
  };
  for (const step of rawSteps) {
    if (typeof step?.url === 'string') urlPool.add(step.url);
    if (Array.isArray(step?.selectors)) {
      for (const inner of step.selectors) {
        if (Array.isArray(inner)) {
          for (const s of inner) addSelector(s);
        } else {
          addSelector(inner);
        }
      }
    }
  }
  return { urlPool, selectorPool, selectorNormalizedToOriginal };
}

// ----- prompt builder -----
function buildPrompt(recorderJson, cleanedRawSteps, verbosity) {
  const verbGuidance = VERBOSITY_GUIDANCE[verbosity] || VERBOSITY_GUIDANCE.normal;
  // Strip large irrelevant fields from each raw step before serializing so the
  // prompt stays focused. Keep type, url, selectors, value, key, x, y.
  const trimmed = cleanedRawSteps.map((s) => {
    const out = { type: s.type };
    if (s.url != null) out.url = s.url;
    if (s.selectors != null) out.selectors = s.selectors;
    if (s.value != null) out.value = s.value;
    if (s.key != null) out.key = s.key;
    if (s.x != null) out.x = s.x;
    if (s.y != null) out.y = s.y;
    return out;
  });

  return `You are a flow improver for an AI demo presenter app. Your job is to take a Chrome
DevTools Recorder export and produce a CLEANED, NARRATED version of the flow that
is ready to play in front of a live audience.

FLOW TITLE: ${recorderJson.title || '(untitled)'}

VERBOSITY LEVEL: ${verbosity}
${verbGuidance}

INPUT RAW STEPS (already pre-cleaned of setViewport/keyUp):
${JSON.stringify(trimmed, null, 2)}

CLEANING RULES:
1. Merge consecutive single-character keyDown events into a single browser_type
   step. Use the selectors from the most recently preceding click or change event
   that targeted an input. Example: keyDown 'p', keyDown 'e', keyDown 'd', keyDown
   'i', keyDown 'a' becomes one browser_type with text "pedia".
2. If a 'change' event is immediately followed by additional keyDowns into the
   same input, merge the change's value with the keyDown characters into a single
   browser_type with the combined text.
3. A trailing 'Enter' keyDown after typed text becomes its own browser_press_key
   with key="Enter" - do NOT fold it into the type step.
4. Preserve every 'navigate' event as a browser_navigate. Do not drop or rewrite
   URLs.
5. Keep scrolls and hovers — they may be needed for the demo even if they seem
   redundant. Only merge consecutive keypresses into browser_type; do not merge
   or remove other step types.
6. NEVER invent steps that weren't in the input AND never remove steps that
   were in the input. The output must preserve every step's intent.

ALLOWED TOOL NAMES (use ONLY these in the "tool" field):
- browser_navigate    params: { url }
- browser_click       params: { selectors: [...] }
- browser_type        params: { selectors: [...], text }
- browser_press_key   params: { key }
- browser_scroll      params: { x, y }
- browser_wait_for    params: { selectors: [...] }
- browser_hover       params: { selectors: [...] }

NARRATION RULES:
- One narration string per output step. Required, never empty.
- Match the verbosity level above EXACTLY.
- Speak as a co-presenter pointing at the screen for an audience. Natural,
  confident, conversational.
- Do NOT say "click", "type", "press", or other UI verbs. Describe what the
  audience is about to SEE, not what you're doing technically.
- Do NOT start two consecutive narrations with the same opening word.
- Do NOT mention selectors, URLs, tools, or any technical detail.

HARD CONSTRAINTS (your output WILL be rejected if violated):
- Every URL in your output MUST appear verbatim in one of the input steps.
- Every selector in your output MUST appear verbatim in one of the input
  selectors arrays. (Inner arrays are flattened - any string anywhere in the
  input selectors counts.)
- Every output step MUST have a non-empty narration.
- The "tool" field MUST be one of the seven allowed names above.
- "selectors" MUST be a FLAT ARRAY OF PLAIN STRINGS. No nesting, no objects.

  WRONG (nested array, rejected):
    "selectors": [["aria/Foo"], ["#bar"]]
  WRONG (objects with value field, rejected):
    "selectors": [{"value": "aria/Foo"}, {"value": "#bar"}]
  WRONG (object map, rejected):
    "selectors": {"primary": "aria/Foo", "fallback": "#bar"}
  RIGHT:
    "selectors": ["aria/Foo", "#bar"]

OUTPUT FORMAT (JSON ONLY, no markdown fences, no preamble, no explanation):
{
  "steps": [
    {
      "tool": "browser_navigate",
      "params": { "url": "https://example.com" },
      "narration": "..."
    },
    {
      "tool": "browser_type",
      "params": { "selectors": ["aria/Search Google or type a URL", "#input"], "text": "wikipedia" },
      "narration": "..."
    }
  ]
}

Return ONLY the JSON object. No other text.`;
}

// ----- output parser + validator -----
// testReport (optional): when present, selectors that don't match the recorder
// pool are ALSO checked against the combined live page snapshots. This lets the
// AI use elements it discovered during testing that weren't in the original recording.
function parseAndValidate(responseText, urlPool, selectorPool, selectorNormalizedToOriginal, testReport) {
  // Build a combined snapshot string for fallback validation when testReport is present.
  const allSnapshotsLower = testReport && Array.isArray(testReport.stepResults)
    ? testReport.stepResults.map(r => r.snapshot || '').join('\n').toLowerCase()
    : null;
  // Strip markdown fences if the model added them despite instructions.
  let jsonText = responseText.trim();
  const fenceMatch = jsonText.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) jsonText = fenceMatch[1];

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error('Improver returned invalid JSON: ' + err.message);
  }

  if (!parsed || !Array.isArray(parsed.steps)) {
    throw new Error('Improver output missing steps array');
  }
  if (parsed.steps.length === 0) {
    throw new Error('Improver returned an empty step list');
  }

  for (let i = 0; i < parsed.steps.length; i++) {
    const step = parsed.steps[i];
    const where = `step ${i + 1}`;

    if (!step || typeof step !== 'object') {
      throw new Error(`${where}: not an object`);
    }
    if (!ALLOWED_TOOLS.has(step.tool)) {
      throw new Error(`${where}: disallowed tool "${step.tool}"`);
    }
    if (!step.narration || typeof step.narration !== 'string' || !step.narration.trim()) {
      throw new Error(`${where}: missing or empty narration`);
    }
    const params = step.params || {};

    if (params.url != null) {
      if (typeof params.url !== 'string') {
        throw new Error(`${where}: url is not a string`);
      }
      if (!urlPool.has(params.url)) {
        throw new Error(`${where}: hallucinated url "${params.url}"`);
      }
    }
    if (params.selectors != null) {
      // Be MAX defensive about selector shapes. The AI is non-deterministic
      // and produces a different mistake every run: nested arrays, object
      // entries with a `value` field, single strings, even objects-as-maps.
      // We accept all of them and normalize to a flat array of strings, then
      // validate the strings against the recorder selector pool. Anything we
      // can't extract a string from is silently dropped (better than dying
      // mid-import and forcing a fallback to the un-narrated flow).
      const normalizedSelectors = normalizeSelectors(params.selectors);
      if (normalizedSelectors.length === 0) {
        throw new Error(`${where}: selectors normalized to empty array`);
      }
      // For each AI selector, accept it if either (a) it's a verbatim match
      // against the original recorder pool, OR (b) its unicode-normalized form
      // matches a recorder selector after normalization. In the latter case
      // we substitute the recorder's ORIGINAL bytes (mojibake and all) back
      // in - the runtime resolver needs to find the live element using the
      // exact text the recorder captured, not the AI's helpfully cleaned
      // version. Anything that doesn't match either way is a hallucination and
      // is SILENTLY DROPPED from this step's selector array — we don't abort
      // the whole import over one bad selector when the step likely has other
      // valid ones that will work at runtime.
      const verified = [];
      for (const sel of normalizedSelectors) {
        // Pass 1: exact match against recorder pool
        if (selectorPool.has(sel)) {
          verified.push(sel);
          continue;
        }
        // Pass 2: unicode-normalized match against recorder pool
        const norm = normalizeForCompare(sel);
        const original = selectorNormalizedToOriginal && selectorNormalizedToOriginal.get(norm);
        if (original) {
          verified.push(original);
          continue;
        }
        // Pass 3 (test-aware): if we have live snapshots, check if the
        // selector is grounded in the actual page state. This lets the AI
        // use elements it discovered during testing that weren't in the
        // original recording.
        if (allSnapshotsLower) {
          if (sel.startsWith('aria/')) {
            const name = sel.slice(5).toLowerCase();
            if (name && allSnapshotsLower.includes(name)) { verified.push(sel); continue; }
          }
          if (sel.startsWith('text/')) {
            const text = sel.slice(5).toLowerCase();
            if (text && allSnapshotsLower.includes(text)) { verified.push(sel); continue; }
          }
          // CSS/xpath pass through when test data is present (same as flowRepairer)
          if (sel.startsWith('#') || sel.startsWith('.') || sel.startsWith('[') || /^[a-z]/.test(sel)) {
            verified.push(sel);
            continue;
          }
        }
        // Hallucinated — drop it silently instead of aborting.
        console.warn(`flowImprover: ${where}: dropping hallucinated selector "${sel}"`);
      }
      params.selectors = verified;
    }
    // Tool-specific shape checks. These are warnings, not fatal — a step with
    // zero selectors will fail at runtime, but Basanti's FLOW_FAILED narration
    // handles that gracefully. Better to keep the narrated flow than to abort
    // the entire import over one broken step.
    if (step.tool === 'browser_navigate' && typeof params.url !== 'string') {
      console.warn(`flowImprover: ${where}: browser_navigate missing url`);
    }
    if (step.tool === 'browser_press_key' && typeof params.key !== 'string') {
      console.warn(`flowImprover: ${where}: browser_press_key missing key`);
    }
    const needsSelectors = ['browser_click', 'browser_hover', 'browser_wait_for', 'browser_type'];
    if (needsSelectors.includes(step.tool) && (!Array.isArray(params.selectors) || params.selectors.length === 0)) {
      console.warn(`flowImprover: ${where}: ${step.tool} has no valid selectors (all were hallucinated or missing)`);
    }
    if (step.tool === 'browser_type' && typeof params.text !== 'string') {
      console.warn(`flowImprover: ${where}: browser_type missing text`);
    }
  }

  return parsed.steps;
}

// ----- main entry point -----
// testReport (optional): when provided, the prompt includes per-step test
// results with live page snapshots so the AI can use battle-tested selectors
// and write narrations that describe the ACTUAL product UI. Validation also
// accepts selectors grounded in the live snapshots (not just the recorder pool).
async function improveFlow(recorderJson, verbosity, apiKey, overrides = {}, testReport = null) {
  if (!recorderJson || typeof recorderJson.title !== 'string' || !Array.isArray(recorderJson.steps)) {
    throw new Error('Invalid Recorder export: missing title or steps');
  }
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set; cannot run AI improver');
  }
  const v = ['brief', 'normal', 'detailed'].includes(verbosity) ? verbosity : 'normal';

  const cleaned = preProcessRawSteps(recorderJson.steps);
  if (cleaned.length === 0) {
    throw new Error('No usable steps after pre-pass (all dropped as artifacts)');
  }

  const { urlPool, selectorPool, selectorNormalizedToOriginal } = buildAllowedPools(recorderJson.steps);
  let prompt = buildPrompt(recorderJson, cleaned, v);

  // Append test report data to the prompt so the AI can see what actually
  // works on the live page and write feature-aware narrations.
  if (testReport && Array.isArray(testReport.stepResults)) {
    prompt += buildTestReportSection(testReport);
  }

  const ai = new GoogleGenAI({ apiKey });

  let response;
  try {
    response = await ai.models.generateContent({
      model: IMPROVER_MODEL,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        temperature: testReport ? 0.2 : 0.3 // more conservative when we have test data
      }
    });
  } catch (err) {
    throw new Error('Improver API call failed: ' + err.message);
  }

  const text = response?.text;
  if (!text || typeof text !== 'string') {
    throw new Error('Improver returned empty response');
  }

  let validatedSteps;
  try {
    validatedSteps = parseAndValidate(text, urlPool, selectorPool, selectorNormalizedToOriginal, testReport);
  } catch (validationErr) {
    console.warn('flowImprover: validation failed:', validationErr.message);
    console.warn('flowImprover: raw model response (truncated):\n' + text.slice(0, 3000));
    throw validationErr;
  }

  const name = overrides.name || recorderJson.title;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  return {
    id,
    name,
    description: overrides.description || '',
    source: testReport ? 'devtools-recorder+ai+tested' : 'devtools-recorder+ai',
    verbosity: v,
    created_at: new Date().toISOString(),
    steps: validatedSteps,
    ...(testReport ? {
      _testReport: {
        passed: testReport.passed,
        failed: testReport.failed,
        total: testReport.totalSteps
      }
    } : {})
  };
}

// Builds the additional prompt section that includes live test results.
function buildTestReportSection(testReport) {
  const stepDetails = testReport.stepResults.map((r, i) => {
    const lines = [
      `STEP ${i + 1}: ${r.tool} — ${r.status.toUpperCase()}`
    ];
    if (r.narration) lines.push(`  Original narration: ${r.narration}`);
    if (r.error) lines.push(`  Error: ${r.error}`);
    if (r.resolvedSelector) lines.push(`  Selector that worked: ${r.resolvedSelector}`);
    if (r.snapshot) lines.push(`  Page state after this step:\n${r.snapshot.slice(0, 3000)}`);
    return lines.join('\n');
  });

  return `

LIVE TEST RESULTS:
This flow was just executed against the live browser. Here are the per-step results
with the actual page state (accessibility tree) after each step. Use this data to:

1. For PASSED steps: keep them EXACTLY as they are. Reorder selectors so the one
   that actually worked comes FIRST. Update the narration to describe what the page
   ACTUALLY shows (use the snapshot to understand the real UI).

2. For FAILED steps: FIX them — do NOT remove or drop them. Look at the snapshot
   for that step to find the correct element. Use "aria/<accessible name>" selectors
   extracted from the snapshot's accessibility tree. The step's INTENT must be
   preserved even if the selector needs to change completely.

3. CRITICAL: You MUST output the SAME NUMBER of steps as the input (or more if
   a step needs to be split into sub-steps to work). NEVER reduce the step count.
   Every original step's intent must appear in your output. If you truly cannot
   find any element matching the intent, keep the step with its original selectors
   and add a comment in the narration like "(may need manual fix)".

4. UNDERSTAND THE PRODUCT: The snapshots show the actual product UI. Write
   narrations that describe the real features and content the audience will see.

5. Do NOT remove, merge, or "simplify" steps. The user recorded these steps for
   a reason. Your job is to make them WORK, not to redesign the flow.

PER-STEP TEST DATA:
${stepDetails.join('\n\n')}`;
}

// ----- mechanical fallback -----
// Used by FlowImporter when improveFlow throws. Wraps convertDevToolsFlow and
// stamps the verbosity field so the flow's shape is consistent regardless of
// which path produced it.
function mechanicalFallback(recorderJson, verbosity, overrides = {}) {
  const flow = convertDevToolsFlow(recorderJson, overrides);
  return { ...flow, verbosity: verbosity || 'normal', source: 'devtools-recorder' };
}

module.exports = {
  improveFlow,
  mechanicalFallback,
  // exported for unit-test/smoke-test access:
  preProcessRawSteps,
  buildAllowedPools,
  parseAndValidate,
  IMPROVER_MODEL,
  // exported for flowRepairer.js reuse:
  normalizeSelectors,
  ALLOWED_TOOLS
};
