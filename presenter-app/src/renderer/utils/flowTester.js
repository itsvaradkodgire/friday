// Probing flow tester. When a step fails, it doesn't just record the failure —
// it takes a snapshot of the live page, extracts candidate selectors from the
// accessibility tree, and ACTUALLY TRIES each one against the live browser
// until one works. The working selector replaces the broken one in the step.
//
// This is what makes flows self-fixing: instead of asking AI to guess which
// selector might work (unreliable), we programmatically probe the real DOM.

// Extracts candidate selectors from an accessibility tree snapshot.
// Returns an array of "aria/<accessible name>" strings sorted by relevance.
function extractCandidatesFromSnapshot(snapshot) {
  if (!snapshot) return [];
  const candidates = [];
  // Match quoted names in the YAML-like accessibility tree:
  //   heading "Example Domain" [level=1] [ref=e3]
  //   link "Learn more" [ref=e5]
  //   button "Submit" [ref=e10]
  const nameRegex = /(?:heading|link|button|textbox|checkbox|radio|tab|menuitem|option|combobox|searchbox|generic|paragraph|img|navigation)\s+"([^"]+)"/gi;
  let match;
  while ((match = nameRegex.exec(snapshot)) !== null) {
    const name = match[1].trim();
    if (name && name.length > 1 && name.length < 200) {
      candidates.push('aria/' + name);
    }
  }
  // Also extract text content patterns like:
  //   - text "Some visible text"
  const textRegex = /text\s+"([^"]+)"/gi;
  while ((match = textRegex.exec(snapshot)) !== null) {
    const text = match[1].trim();
    if (text && text.length > 1 && text.length < 200) {
      candidates.push('text/' + text);
    }
  }
  // Also extract ref-based selectors [ref=eN] — these are exact snapshot refs
  // that the MCP browser_click natively understands (no __resolve needed)
  const refRegex = /\[ref=(e\d+)\]/g;
  while ((match = refRegex.exec(snapshot)) !== null) {
    candidates.push('[ref=' + match[1] + ']');
  }
  // Deduplicate
  return [...new Set(candidates)];
}

// Scores how relevant a candidate selector is to the original step's intent.
// Higher score = more likely to be the right element. Uses the original
// selectors and narration as hints about what we're looking for.
function scoreCandidate(candidate, originalStep) {
  let score = 0;
  const candLower = candidate.toLowerCase();
  // Check if any original selector's name/text overlaps with this candidate
  const origSelectors = originalStep.params?.selectors || [];
  for (const orig of origSelectors) {
    const origName = orig.startsWith('aria/') ? orig.slice(5).toLowerCase()
      : orig.startsWith('text/') ? orig.slice(5).toLowerCase()
      : '';
    if (origName && candLower.includes(origName)) { score += 10; break; }
    if (origName) {
      // Partial word overlap
      const origWords = origName.split(/\s+/).filter(w => w.length > 2);
      for (const w of origWords) {
        if (candLower.includes(w)) score += 2;
      }
    }
  }
  // Check narration for keyword hints
  if (originalStep.narration) {
    const narrWords = originalStep.narration.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    for (const w of narrWords) {
      if (candLower.includes(w)) score += 1;
    }
  }
  return score;
}

// For a selector-bearing tool, build the MCP params with a single candidate selector
function buildProbeParams(tool, originalParams, candidateSelector) {
  const params = { ...originalParams };
  params.selectors = [candidateSelector];
  return params;
}

async function testFlow(flow, callMCPTool, onStepComplete) {
  if (!flow || !Array.isArray(flow.steps) || flow.steps.length === 0) {
    throw new Error('testFlow: flow has no steps');
  }
  if (typeof callMCPTool !== 'function') {
    throw new Error('testFlow: callMCPTool is not a function');
  }

  const SELECTOR_TOOLS = new Set(['browser_click', 'browser_type', 'browser_hover', 'browser_wait_for']);
  const MAX_PROBES = 8; // max candidates to try per failed step

  const report = {
    flowId: flow.id || 'unknown',
    flowName: flow.name || '(unnamed)',
    startedAt: new Date().toISOString(),
    completedAt: null,
    totalSteps: flow.steps.length,
    passed: 0,
    failed: 0,
    fixed: 0,
    stepResults: []
  };

  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    const t0 = Date.now();
    const result = {
      index: i,
      tool: step.tool,
      params: step.params,
      narration: step.narration || '',
      status: 'pass',
      error: null,
      resolvedSelector: null,
      fixedSelector: null,   // set when probing found a working replacement
      snapshot: null,
      durationMs: 0
    };

    // Skip browser_resize
    if (step.tool === 'browser_resize') {
      result.durationMs = 0;
      report.passed++;
      report.stepResults.push(result);
      if (onStepComplete) onStepComplete(i, result, report);
      continue;
    }

    // --- Try the step as-is ---
    let stepPassed = false;
    try {
      await callMCPTool(step.tool, step.params);
      stepPassed = true;
    } catch (err) {
      result.error = err.message;
    }

    // --- If failed AND it's a selector-bearing tool, PROBE for a working selector ---
    if (!stepPassed && SELECTOR_TOOLS.has(step.tool)) {
      // Take a snapshot to see what's actually on the page
      let snapshot = null;
      try {
        const snap = await callMCPTool('browser_snapshot', {});
        snapshot = (snap?.content?.[0]?.text ?? '').slice(0, 8000);
      } catch {}

      if (snapshot) {
        // Extract candidates from the live page
        const candidates = extractCandidatesFromSnapshot(snapshot);
        // Score and sort by relevance to the original step's intent
        const scored = candidates
          .map(c => ({ sel: c, score: scoreCandidate(c, step) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, MAX_PROBES);

        // Actually TRY each candidate against the live browser
        for (const { sel } of scored) {
          try {
            const probeParams = buildProbeParams(step.tool, step.params, sel);
            await callMCPTool(step.tool, probeParams);
            // It worked! Record the fix.
            stepPassed = true;
            result.fixedSelector = sel;
            result.error = null;
            report.fixed++;
            break;
          } catch {
            // This candidate didn't work, try the next one
          }
        }
      }
    }

    result.durationMs = Date.now() - t0;
    result.status = stepPassed ? 'pass' : 'fail';

    // Take a snapshot AFTER the step (for the report / optimizer)
    try {
      const snap = await callMCPTool('browser_snapshot', {});
      result.snapshot = (snap?.content?.[0]?.text ?? '').slice(0, 6000);
    } catch {}

    if (result.status === 'pass') {
      report.passed++;
      // Record which selector resolved
      if (result.fixedSelector) {
        result.resolvedSelector = result.fixedSelector;
      } else if (Array.isArray(step.params?.selectors)) {
        result.resolvedSelector = probeResolvedSelector(step.params.selectors, result.snapshot);
      }
    } else {
      report.failed++;
    }

    report.stepResults.push(result);
    if (onStepComplete) onStepComplete(i, result, report);
  }

  report.completedAt = new Date().toISOString();
  return report;
}

function probeResolvedSelector(selectors, snapshot) {
  if (!snapshot || !selectors || selectors.length === 0) return null;
  const snapLower = snapshot.toLowerCase();
  for (const sel of selectors) {
    if (sel.startsWith('aria/')) {
      const name = sel.slice(5).toLowerCase();
      if (name && snapLower.includes(name)) return sel;
    }
    if (sel.startsWith('text/')) {
      const text = sel.slice(5).toLowerCase();
      if (text && snapLower.includes(text)) return sel;
    }
    if (selectors.length === 1) return sel;
  }
  return selectors[0];
}

// Builds an improved flow from the test report: replaces broken selectors
// with ones that actually worked during probing. For passed steps, promotes
// the working selector to index 0. For steps that were fixed by probing,
// uses the fixed selector. Steps that couldn't be fixed are kept as-is.
function buildFixedFlow(flow, report) {
  if (!report || !report.stepResults) return flow;
  const steps = flow.steps.map((step, i) => {
    const result = report.stepResults[i];
    if (!result) return step;

    // Step was fixed by probing — use the fixed selector
    if (result.fixedSelector && Array.isArray(step.params?.selectors)) {
      const sels = [result.fixedSelector, ...step.params.selectors];
      // Deduplicate
      const unique = [...new Set(sels)];
      return { ...step, params: { ...step.params, selectors: unique } };
    }

    // Step passed with original selectors — promote the working one
    if (result.resolvedSelector && Array.isArray(step.params?.selectors)) {
      const sels = [...step.params.selectors];
      const idx = sels.indexOf(result.resolvedSelector);
      if (idx > 0) {
        sels.splice(idx, 1);
        sels.unshift(result.resolvedSelector);
      }
      return { ...step, params: { ...step.params, selectors: sels } };
    }

    return step;
  });

  return {
    ...flow,
    steps,
    source: 'devtools-recorder+ai+tested',
    _testReport: {
      passed: report.passed,
      failed: report.failed,
      fixed: report.fixed || 0,
      total: report.totalSteps
    }
  };
}

// Legacy alias
function reorderSelectorsFromReport(flow, report) {
  return buildFixedFlow(flow, report);
}

module.exports = {
  testFlow,
  buildFixedFlow,
  reorderSelectorsFromReport,
  probeResolvedSelector,
  extractCandidatesFromSnapshot,
  scoreCandidate
};
