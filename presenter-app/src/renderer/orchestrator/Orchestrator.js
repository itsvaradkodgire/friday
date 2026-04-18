// Orchestrator — the single brain for all Gemini function calls.
//
// Owns: intent classification, flow execution, direct MCP actions,
// narration queue, execution registry, manual control.
//
// Plain ES class — no React, no refs. useOrchestrator.js is the thin
// React bridge that wires this to the component tree.

const { FunctionResponseScheduling } = require('@google/genai');
const { NarrationQueue } = require('./NarrationQueue');
const { findBestFlow } = require('../utils/buildSearchIndex');
const { repairFlow } = require('../utils/flowRepairer');

// --- intent classification helpers ---

const INTENT_SCREENSHOT = /\b(screenshot|capture|snap)\b/i;
const INTENT_HIGHLIGHT  = /\b(highlight|outline|point\s*(at|to|out)|circle)\b/i;
const INTENT_SCROLL     = /\b(scroll)\b/i;
const INTENT_NAVIGATE   = /^(go\s+to|open|navigate\s+to|visit)\s+/i;
// URL-like: starts with http/https or contains .com/.io/.org etc.
const INTENT_URL        = /https?:\/\/|www\.|\.com|\.io|\.org|\.net|\.dev/i;

function classifyIntent(intent) {
  if (!intent) return 'unknown';
  if (INTENT_SCREENSHOT.test(intent)) return 'screenshot';
  if (INTENT_HIGHLIGHT.test(intent))  return 'highlight';
  // "scroll to X" but not "show the scroll feature" — must start with scroll or
  // be obviously a scroll command.
  if (INTENT_SCROLL.test(intent) && /^scroll\b/i.test(intent.trim())) return 'scroll';
  if (INTENT_URL.test(intent))        return 'navigate';
  if (INTENT_NAVIGATE.test(intent))   return 'navigate';
  return 'flow'; // default: try to match a flow
}

// Extract a URL from an intent string.
function extractUrl(intent) {
  const match = intent.match(/https?:\/\/\S+/);
  if (match) return match[0];
  // "go to example.com" → add https://
  const domainMatch = intent.match(/(?:go\s+to|open|navigate\s+to|visit)\s+([\w.-]+\.\w{2,}(?:\/\S*)?)/i);
  if (domainMatch) return 'https://' + domainMatch[1];
  return null;
}

// Extract a selector-ish string from "highlight the X" or "scroll to X".
function extractSelector(intent) {
  // Try quoted string first: highlight "Sign Up"
  const quoted = intent.match(/["']([^"']+)["']/);
  if (quoted) return quoted[1];
  // "highlight the sign up button" → "sign up button"
  const after = intent.match(/(?:highlight|outline|scroll\s+to|point\s+(?:at|to))\s+(?:the\s+)?(.+)/i);
  if (after) return after[1].trim();
  return null;
}

// --- post-step dwell timing ---

function getPostStepDwellMs(step, hadNarration) {
  if (hadNarration) return 250;
  switch (step.tool) {
    case 'browser_navigate':  return 1500;
    case 'browser_wait_for':  return 200;
    case 'browser_press_key': return 200;
    case 'browser_scroll':    return 800;
    case 'browser_click':     return 1000;
    case 'browser_type':      return 900;
    case 'browser_hover':     return 700;
    default:                  return 800;
  }
}

// =======================================================================

class Orchestrator {
  constructor({ callMCPTool, emitLog }) {
    this._callMCPTool = callMCPTool;
    this._emitLog = emitLog;

    this._narrationQueue = new NarrationQueue();

    // Execution registry (replaces module-level singleton Map).
    this._executions = new Map();

    // Live state — set via setters from useOrchestrator.
    this._appMode = 'IDLE';
    this._flows = [];
    this._searchIndex = new Map();
    this._sections = [];

    // Session methods — bound/unbound with session lifecycle.
    this._sendText = null;
    this._sendToolResponse = null;

    // React notification callbacks.
    this._onAppModeChange = null;
    this._onExecutionChange = null;

    // Tool calls received during MANUAL mode. Drained on resume.
    this._queuedToolCalls = [];
  }

  // --- session binding ---

  bindSession({ sendText, sendToolResponse }) {
    this._sendText = sendText;
    this._sendToolResponse = sendToolResponse;
    this._narrationQueue.bind(sendText);
  }

  unbindSession() {
    this._narrationQueue.unbind();
    this._sendText = null;
    this._sendToolResponse = null;
  }

  // --- state setters (called from useOrchestrator) ---

  setFlows(flows) { this._flows = flows; }
  setSearchIndex(index) { this._searchIndex = index; }
  setSections(sections) { this._sections = sections || []; }
  setCallMCPTool(fn) { this._callMCPTool = fn; }

  setAppMode(mode) {
    this._appMode = mode;
    if (this._onAppModeChange) this._onAppModeChange(mode);
  }

  onAppModeChange(cb) { this._onAppModeChange = cb; }
  onExecutionChange(cb) { this._onExecutionChange = cb; }

  get appMode() { return this._appMode; }

  getActiveExecution() {
    for (const exec of this._executions.values()) {
      if (exec.status === 'running') return exec;
    }
    return null;
  }

  // --- message routing (called by session for every incoming message) ---

  handleMessage(msg) {
    if (msg.serverContent?.turnComplete) {
      this._narrationQueue.onTurnComplete();
    }

    if (msg.toolCall) {
      this._handleToolCall(msg.toolCall);
    }

    if (msg.serverContent?.inputTranscription?.text && this._emitLog) {
      this._emitLog({ event: 'transcript', who: 'user', text: msg.serverContent.inputTranscription.text });
    }
    if (msg.serverContent?.outputTranscription?.text && this._emitLog) {
      this._emitLog({ event: 'transcript', who: 'gemini', text: msg.serverContent.outputTranscription.text });
    }
  }

  // --- single entry point for ALL function calls ---

  async _handleToolCall(toolCall) {
    // MANUAL mode: queue, don't execute.
    if (this._appMode === 'MANUAL') {
      this._queuedToolCalls.push(toolCall);
      return;
    }

    const functionResponses = [];

    for (const fc of toolCall.functionCalls) {
      const intent = (fc.args && fc.args.intent) || '';

      // PRESENTING mode: a flow is already running. Gemini sometimes calls
      // do_action in response to narration text — reject it so we don't
      // cancel the in-flight flow and loop.
      let result, scheduling;
      if (this._appMode === 'PRESENTING') {
        result = {
          status: 'busy',
          next: 'A flow is already playing. STAY SILENT and wait for the FLOW_COMPLETE message before calling do_action again.'
        };
        scheduling = FunctionResponseScheduling.SILENT;
      } else {
        ({ result, scheduling } = await this._dispatch(intent));
      }

      functionResponses.push({
        id: fc.id,
        name: fc.name,
        response: {
          result,
          ...(scheduling ? { scheduling } : {})
        }
      });
    }

    if (this._sendToolResponse) {
      this._sendToolResponse({ functionResponses });
    }
  }

  // Classify intent and route to the right handler. Returns { result, scheduling }.
  async _dispatch(intent) {
    const kind = classifyIntent(intent);

    switch (kind) {
      case 'screenshot':
        return this._doScreenshot();
      case 'highlight':
        return this._doHighlight(intent);
      case 'scroll':
        return this._doScroll(intent);
      case 'navigate':
        return this._doNavigate(intent);
      case 'flow':
      default:
        return this._doFlow(intent);
    }
  }

  // --- direct actions (fast, return result with SILENT scheduling) ---

  async _doScreenshot() {
    try {
      const result = await this._callMCPTool('browser_screenshot', {});
      const imageBlock = result?.content?.find((c) => c.type === 'image');
      this._log({ tool: 'browser_screenshot', params: {}, status: 'ok' });
      return {
        result: { status: 'completed', image: imageBlock?.data ?? null, mimeType: imageBlock?.mimeType ?? 'image/png' },
        scheduling: FunctionResponseScheduling.SILENT
      };
    } catch (err) {
      this._log({ tool: 'browser_screenshot', params: {}, status: 'failed' });
      return { result: { status: 'failed', error: err.message }, scheduling: FunctionResponseScheduling.SILENT };
    }
  }

  async _doHighlight(intent) {
    const selector = extractSelector(intent);
    if (!selector) {
      return { result: { status: 'failed', error: 'Could not determine what to highlight' }, scheduling: FunctionResponseScheduling.SILENT };
    }
    try {
      await this._callMCPTool('browser_evaluate', {
        expression: `
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
          const orig = { outline: el.style.outline, offset: el.style.outlineOffset };
          el.style.outline = '3px solid #FF4444';
          el.style.outlineOffset = '2px';
          setTimeout(() => {
            el.style.outline = orig.outline;
            el.style.outlineOffset = orig.offset;
          }, 3000);
        `
      });
      this._log({ tool: 'highlight_element', params: { selector }, status: 'ok' });
      return { result: { status: 'completed', selector }, scheduling: FunctionResponseScheduling.SILENT };
    } catch (err) {
      this._log({ tool: 'highlight_element', params: { selector }, status: 'failed' });
      return { result: { status: 'failed', error: err.message }, scheduling: FunctionResponseScheduling.SILENT };
    }
  }

  async _doScroll(intent) {
    const selector = extractSelector(intent);
    if (!selector) {
      return { result: { status: 'failed', error: 'Could not determine what to scroll to' }, scheduling: FunctionResponseScheduling.SILENT };
    }
    try {
      await this._callMCPTool('browser_evaluate', {
        expression: `
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        `
      });
      this._log({ tool: 'scroll_to_section', params: { selector }, status: 'ok' });
      return { result: { status: 'completed', selector }, scheduling: FunctionResponseScheduling.SILENT };
    } catch (err) {
      this._log({ tool: 'scroll_to_section', params: { selector }, status: 'failed' });
      return { result: { status: 'failed', error: err.message }, scheduling: FunctionResponseScheduling.SILENT };
    }
  }

  async _doNavigate(intent) {
    const url = extractUrl(intent);
    if (!url) {
      return { result: { status: 'failed', error: 'Could not determine URL' }, scheduling: FunctionResponseScheduling.SILENT };
    }
    try {
      await this._callMCPTool('browser_navigate', { url });
      await this._callMCPTool('browser_wait_for', { selector: 'body', timeout: 5000 });
      this._log({ tool: 'browser_navigate', params: { url }, status: 'ok' });
      return { result: { status: 'completed', url }, scheduling: FunctionResponseScheduling.SILENT };
    } catch (err) {
      this._log({ tool: 'browser_navigate', params: { url }, status: 'failed' });
      return { result: { status: 'failed', error: err.message }, scheduling: FunctionResponseScheduling.SILENT };
    }
  }

  // --- flow execution (long-running, fire-and-forget, WHEN_IDLE) ---

  _doFlow(intent) {
    const flow = findBestFlow(intent, this._searchIndex, this._flows);

    if (!flow) {
      return {
        result: {
          status: 'not_found',
          say: 'No matching demo flow found for that request.',
          next: 'Describe what you see on screen and ask the presenter to clarify.'
        },
        scheduling: FunctionResponseScheduling.WHEN_IDLE
      };
    }

    // Cancel any running flow before starting a new one.
    this._cancelAllRunning();

    const executionId = `exec_${Date.now()}`;
    this._createExecution(executionId, flow);
    this.setAppMode('PRESENTING');
    this._log({ event: 'flow_started', flowId: flow.id });

    // Fire and forget — the step loop runs in the background.
    this._executeFlow(executionId, flow);

    return {
      result: {
        status: 'playing',
        flowName: flow.name,
        next: 'The flow is now playing with built-in narration. STAY SILENT until you receive a FLOW_COMPLETE message. Do not call do_action again. The runtime is speaking through you.'
      },
      scheduling: FunctionResponseScheduling.WHEN_IDLE
    };
  }

  // Public: play a flow from the library (skips intent resolution).
  playFlow(flow) {
    this._cancelAllRunning();
    const executionId = `manual_${Date.now()}`;
    this._createExecution(executionId, flow);
    this.setAppMode('PRESENTING');
    this._log({ event: 'flow_started', flowId: flow.id });
    this._executeFlow(executionId, flow);
  }

  // --- flow step loop (ported from useExecutionRegistry.js) ---

  async _executeFlow(executionId, flow) {
    const exec = this._executions.get(executionId);
    if (!exec) return;

    // Inject flow-linked KB context before the first step. This gives Basanti
    // deep product knowledge to weave into her narration for this flow.
    this._injectFlowContext(flow);

    for (let i = 0; i < flow.steps.length; i++) {
      if (exec.cancelled) {
        exec.status = 'cancelled';
        this._notifyExecution();
        this._log({ event: 'flow_cancelled', flowId: flow.id });
        return;
      }

      const step = flow.steps[i];

      // Skip browser_resize (defense in depth).
      if (step.tool === 'browser_resize') {
        exec.progress.current = i + 1;
        this._notifyExecution();
        continue;
      }

      // ----- narrate phase -----
      let hadNarration = false;
      if (step.narration) {
        try {
          let narrationText = step.narration;
          if (step.tool !== 'browser_navigate' && step.tool !== 'browser_press_key') {
            try {
              const snap = await this._callMCPTool('browser_snapshot', {});
              const snapText = (snap?.content?.[0]?.text ?? '').slice(0, 1500);
              if (snapText) {
                narrationText = `NARRATE_WITH_CONTEXT: The script says: "${step.narration}" — but adapt it to what's ACTUALLY on screen right now. Do NOT read the script verbatim if the page content is different. Describe what you see instead, keeping the same tone and length. Current page:\n${snapText}`;
              }
            } catch {}
          }
          await this._narrationQueue.enqueue(narrationText);
          hadNarration = true;
        } catch (err) {
          console.warn('Step narration failed, continuing silently:', err.message);
        }
      }

      // Check cancellation after narration (presenter may have hit Take Control).
      if (exec.cancelled) {
        exec.status = 'cancelled';
        this._notifyExecution();
        this._log({ event: 'flow_cancelled', flowId: flow.id });
        return;
      }

      // ----- execute phase -----
      try {
        await this._callMCPTool(step.tool, step.params);
        exec.progress.current = i + 1;
        this._notifyExecution();
      } catch (err) {
        // Step failed — attempt self-healing.
        let snapshotText = null;
        try {
          const snapshot = await this._callMCPTool('browser_snapshot', {});
          snapshotText = (snapshot?.content?.[0]?.text ?? '').slice(0, 4000);
        } catch {}

        const apiKey = (typeof window !== 'undefined' && window.appEnv && window.appEnv.GEMINI_API_KEY) || '';
        if (snapshotText && !exec._repairAttempted && apiKey) {
          exec._repairAttempted = true;
          const remainingSteps = flow.steps.slice(i);

          let repairedSteps = null;
          try {
            const results = await Promise.all([
              this._narrationQueue.enqueue(
                'FLOW_HEALING: A step needs adjustment. Say something brief and natural like "Let me take a slightly different approach here" — do NOT mention errors, selectors, or technical details. Keep it to one sentence.'
              ).catch(() => {}),
              repairFlow({
                snapshot: snapshotText,
                failedStep: step,
                error: err.message,
                remainingSteps,
                flowName: flow.name || flow.id,
                apiKey
              }).catch((repairErr) => {
                console.warn('Flow repair failed:', repairErr.message);
                return null;
              })
            ]);
            repairedSteps = results[1];
          } catch (repairOuterErr) {
            console.warn('Self-healing outer error:', repairOuterErr.message);
          }

          if (repairedSteps && repairedSteps.length > 0) {
            flow.steps.splice(i, flow.steps.length - i, ...repairedSteps);
            exec.progress.total = flow.steps.length;
            i--;
            continue;
          }
        }

        // Repair not attempted or failed — halt.
        exec.status = 'failed';
        exec.result = { error: err.message, snapshot: snapshotText };
        this._notifyExecution();
        this._log({ event: 'flow_failed', flowId: flow.id, error: err.message });

        try {
          await this._narrationQueue.enqueue(
            `FLOW_FAILED: A step in the demo failed (${err.message}). The page may not be where you expected. Briefly tell the audience there was a hiccup, then ask the presenter what they would like to do next.`
          );
        } catch {}

        this.setAppMode('IDLE');
        return;
      }

      // Post-step dwell.
      await new Promise((r) => setTimeout(r, getPostStepDwellMs(step, hadNarration)));
    }

    // Flow completed successfully.
    exec.status = 'completed';
    exec.result = { stepsRun: flow.steps.length, flowId: flow.id };
    this._notifyExecution();
    this._log({ event: 'flow_completed', flowId: flow.id });

    try {
      await this._narrationQueue.enqueue(
        'FLOW_COMPLETE: The flow just finished. In one or two natural sentences, tell the audience what is on screen now, then ask the presenter what they would like to see next. Do not call any function — wait for the presenter to respond.'
      );
    } catch {}

    this.setAppMode('IDLE');
  }

  // --- manual control ---

  async toggleManualControl() {
    if (this._appMode !== 'MANUAL') {
      // Enter manual mode.
      this.setAppMode('MANUAL');
      this._cancelAllRunning();
      this._narrationQueue.flush();

      if (this._sendText) {
        try {
          this._sendText(
            'SYSTEM: The presenter has taken manual control of the browser. Do not call any functions. Wait until told to resume.'
          );
        } catch {}
      }
    } else {
      // Return control.
      let snapshotContext = 'Current page state unknown.';
      try {
        const snapshot = await this._callMCPTool('browser_snapshot', {});
        snapshotContext = snapshot?.content?.[0]?.text?.slice(0, 1500) ?? snapshotContext;
      } catch {}

      this.setAppMode('IDLE');

      if (this._sendText) {
        try {
          this._sendText(
            `SYSTEM: The presenter has returned control. Current browser state: ${snapshotContext}`
          );
        } catch {}
      }

      // Drain queued tool calls.
      const queued = this._queuedToolCalls.splice(0);
      for (const tc of queued) {
        this._handleToolCall(tc);
      }

      this._log({ event: 'mode_change', mode: 'IDLE' });
    }
  }

  // --- execution registry ---

  _createExecution(id, flow) {
    const entry = {
      status: 'running',
      flow,
      progress: { current: 0, total: flow.steps.length },
      startedAt: Date.now(),
      cancelled: false,
      result: null,
      _repairAttempted: false
    };
    this._executions.set(id, entry);
    this._notifyExecution();
    return entry;
  }

  _cancelAllRunning() {
    for (const exec of this._executions.values()) {
      if (exec.status === 'running') {
        exec.cancelled = true;
      }
    }
    this._narrationQueue.flush();
  }

  // --- KB context injection ---

  _injectFlowContext(flow) {
    if (!this._sendText || !this._sections.length) return;
    // Find sections linked to this flow.
    const linked = this._sections.filter(
      (s) => s.flowIds && s.flowIds.includes(flow.id)
    );
    if (linked.length === 0) return;

    const contextBlocks = linked
      .map((s) => `## ${s.title}\n${s.content}`)
      .join('\n\n');

    try {
      this._sendText(
        `CONTEXT: You are about to demo "${flow.name}". Here is relevant product knowledge — use it naturally in your narration. Do NOT read it verbatim. Do NOT call do_action.\n\n${contextBlocks}`
      );
    } catch (err) {
      console.warn('Failed to inject flow context:', err.message);
    }
  }

  // --- notifications ---

  _notifyExecution() {
    if (this._onExecutionChange) this._onExecutionChange();
  }

  _log(entry) {
    if (typeof this._emitLog === 'function') {
      this._emitLog(entry);
    }
  }
}

module.exports = { Orchestrator, classifyIntent, extractUrl, extractSelector };
