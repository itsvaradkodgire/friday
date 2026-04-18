// Runtime flow repairer. When a step fails mid-demo, this module takes a
// snapshot of the current page, sends it + the failed step + the remaining
// steps to gemini-2.5-flash, and gets back corrected replacement steps that
// use ONLY elements visible in the live accessibility tree.
//
// Design constraints:
//   - Must complete in <12 seconds (the audience is waiting)
//   - Basanti covers the gap with a stalling narration (runs concurrently)
//   - Validates selectors against the LIVE snapshot, not the recorder pool
//   - Hallucinated selectors are silently dropped, not fatal
//   - Max 1 repair attempt per flow execution (caller enforces this)

const { GoogleGenAI } = require('@google/genai');
const { normalizeSelectors, ALLOWED_TOOLS } = require('./flowImprover');

const REPAIRER_MODEL = 'gemini-2.5-flash';

function buildRepairPrompt({ snapshot, failedStep, error, remainingSteps, flowName }) {
  const remainingJson = JSON.stringify(remainingSteps.map((s) => ({
    tool: s.tool,
    params: s.params,
    narration: s.narration || ''
  })), null, 2);

  return `You are a runtime flow repairer for a live AI demo presenter called Basanti. A step
in a live demo just failed. Your job: produce CORRECTED replacement steps that achieve
the same goal, using ONLY elements visible in the current page snapshot below.

FLOW: ${flowName || '(unnamed)'}

FAILED STEP:
${JSON.stringify({ tool: failedStep.tool, params: failedStep.params, narration: failedStep.narration || '' })}

ERROR: ${error}

REMAINING STEPS (the failed step + everything after it — these are what you must replace):
${remainingJson}

CURRENT PAGE STATE (accessibility tree — every interactive element on the page is listed here):
${snapshot}

RULES:
1. Output replacement steps for ALL remaining steps listed above, not just the failed one.
   Preserve the INTENT of each original step.
2. For selectors, use ONLY elements from the page snapshot above:
   - Use "aria/<accessible name>" format — extract the name from quoted strings in the snapshot
     (e.g. heading "Example Domain" becomes "aria/Example Domain")
   - Or use "text/<visible text>" for elements with visible text content
   - Or use ref-based element references if the snapshot has [ref=...] tags
3. Do NOT invent elements that aren't in the snapshot. If you can't find a matching
   element for a step's intent, SKIP that step entirely.
4. If the page is in a completely unexpected state (wrong site, error page, etc.),
   start with a browser_navigate to get back on track using a URL from the original steps.
5. Each output step MUST have a "narration" field (5-15 words, natural speech, no UI verbs
   like "click" or "type"). Basanti will speak this to the audience before the action executes.
6. Keep step count MINIMAL — the audience is waiting.

ALLOWED TOOLS: browser_navigate, browser_click, browser_type, browser_press_key,
browser_scroll, browser_wait_for, browser_hover

OUTPUT: JSON only. No markdown fences, no preamble, no explanation.
{"steps": [{"tool": "...", "params": {...}, "narration": "..."}, ...]}`;
}

function validateRepairOutput(steps, snapshot) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('Repairer returned empty step list');
  }

  const snapshotLower = (snapshot || '').toLowerCase();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const where = `repair step ${i + 1}`;

    if (!step || typeof step !== 'object') {
      throw new Error(`${where}: not an object`);
    }
    if (!ALLOWED_TOOLS.has(step.tool)) {
      throw new Error(`${where}: disallowed tool "${step.tool}"`);
    }
    if (!step.narration || typeof step.narration !== 'string' || !step.narration.trim()) {
      step.narration = 'Continuing with the demonstration.';
    }

    const params = step.params || {};
    step.params = params;

    if (params.selectors != null) {
      const normalized = normalizeSelectors(params.selectors);
      const verified = [];
      for (const sel of normalized) {
        // CSS selectors pass through — can't validate against accessibility tree
        if (sel.startsWith('#') || sel.startsWith('.') || sel.startsWith('[') || /^[a-z]/.test(sel)) {
          verified.push(sel);
          continue;
        }
        // aria/ selectors: check the name portion appears in the snapshot
        if (sel.startsWith('aria/')) {
          const name = sel.slice(5).toLowerCase();
          if (name && snapshotLower.includes(name)) {
            verified.push(sel);
            continue;
          }
        }
        // text/ selectors: check the text portion appears in the snapshot
        if (sel.startsWith('text/')) {
          const text = sel.slice(5).toLowerCase();
          if (text && snapshotLower.includes(text)) {
            verified.push(sel);
            continue;
          }
        }
        // xpath, pierce — pass through (can't validate meaningfully)
        if (sel.startsWith('xpath') || sel.startsWith('pierce/')) {
          verified.push(sel);
          continue;
        }
        // Didn't match any pass-through rule and not found in snapshot — drop
        console.warn(`flowRepairer: ${where}: dropping selector "${sel}" (not in snapshot)`);
      }
      params.selectors = verified;
      if (verified.length === 0) {
        console.warn(`flowRepairer: ${where}: all selectors dropped for ${step.tool}`);
      }
    }
  }

  return steps;
}

async function repairFlow({ snapshot, failedStep, error, remainingSteps, flowName, apiKey }) {
  if (!apiKey) {
    throw new Error('No API key for flow repair');
  }
  if (!snapshot) {
    throw new Error('No snapshot available for repair');
  }

  const prompt = buildRepairPrompt({ snapshot, failedStep, error, remainingSteps, flowName });

  const ai = new GoogleGenAI({ apiKey });

  let response;
  try {
    response = await ai.models.generateContent({
      model: REPAIRER_MODEL,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.2
      }
    });
  } catch (err) {
    throw new Error('Repair API call failed: ' + err.message);
  }

  const text = response?.text;
  if (!text || typeof text !== 'string') {
    throw new Error('Repairer returned empty response');
  }

  // Strip markdown fences if the model added them
  let jsonText = text.trim();
  const fenceMatch = jsonText.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) jsonText = fenceMatch[1];

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    console.warn('flowRepairer: invalid JSON from AI:', jsonText.slice(0, 1000));
    throw new Error('Repairer returned invalid JSON: ' + err.message);
  }

  if (!parsed || !Array.isArray(parsed.steps)) {
    throw new Error('Repairer output missing steps array');
  }

  return validateRepairOutput(parsed.steps, snapshot);
}

module.exports = { repairFlow, validateRepairOutput, buildRepairPrompt };
