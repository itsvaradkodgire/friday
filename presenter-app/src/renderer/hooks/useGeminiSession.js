// Gemini Live API — pure I/O layer.
//
// Model:     gemini-2.5-flash-native-audio-preview-12-2025
// SDK:       @google/genai
// Audio in:  16-bit PCM, 16 kHz, mono (push-to-talk)
// Audio out: 16-bit PCM, 24 kHz, mono
//
// This hook handles ONLY: connection lifecycle, audio capture/playback,
// and message forwarding. All orchestration (tool calls, flow execution,
// narration) lives in Orchestrator.js.

const { useEffect, useRef, useState, useCallback } = require('react');
const {
  GoogleGenAI,
  Modality,
  Behavior
} = require('@google/genai');

const MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';

const FUNCTION_DECLARATIONS = [
  {
    name: 'do_action',
    description:
      'Call this for ANY browser action — showing demos, navigating pages, scrolling, highlighting elements, taking screenshots. Describe what you want in plain English.',
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description:
            'What to do. e.g. "show the pricing page", "scroll to features", "highlight the signup button", "take a screenshot"'
        }
      },
      required: ['intent']
    }
  }
];

function buildSystemPrompt(flows, knowledge, sections) {
  const flowList = (flows || [])
    .map(
      (f) =>
        `  - "${f.id}": ${f.name}${f.description ? ` — ${f.description}` : ''}`
    )
    .join('\n');

  const knowledgeBlock =
    knowledge && knowledge.trim()
      ? `\n--- KNOWLEDGE BASE ---\nThe following content is your ground-truth context for this session. Treat it as authoritative when it conflicts with your pretraining.\n\n${knowledge.trim()}\n--- END KNOWLEDGE BASE ---\n`
      : '';

  // Build condensed topic index from KB sections. Basanti sees titles +
  // summaries + linked flows so she knows what she can talk about and demo.
  // Full content is injected dynamically when relevant (see Orchestrator).
  let topicIndex = '';
  if (sections && sections.length > 0) {
    const lines = sections.map((s) => {
      const linkedFlows = (s.flowIds || [])
        .map((fid) => {
          const flow = (flows || []).find((f) => f.id === fid);
          return flow ? `"${flow.name}"` : null;
        })
        .filter(Boolean);
      const flowNote = linkedFlows.length > 0 ? ` Related demo${linkedFlows.length > 1 ? 's' : ''}: ${linkedFlows.join(', ')}.` : '';
      return `  - "${s.title}"${s.summary ? ` — ${s.summary}` : ''}${flowNote}`;
    });
    topicIndex = `\n--- KNOWLEDGE TOPICS ---
You have deep knowledge on these topics. Detailed context will be provided automatically when a related flow runs. You can also talk about these topics confidently when asked.

${lines.join('\n')}

When someone asks about a topic, speak naturally from what you know. When someone wants to SEE a topic in action, call do_action with the relevant intent — the matching flow will play.
--- END KNOWLEDGE TOPICS ---\n`;
  }

  return `You are an AI demo presenter assistant. You work alongside a human presenter to demonstrate a software product to an audience. The audience is watching a live browser screen.

Your role:
- Listen to the presenter and the audience
- When the presenter asks you to show something, call do_action to make it happen
- Provide natural, engaging commentary about what is on screen
- Keep responses concise and presentation-friendly
${knowledgeBlock}${topicIndex}
Available demo flows:
${flowList || '  (no flows loaded yet)'}

How to use do_action:
1. Call do_action with a plain-English intent for ANY browser action.
   Examples:
     do_action({ intent: "show the pricing page" })
     do_action({ intent: "scroll to the features section" })
     do_action({ intent: "highlight the signup button" })
     do_action({ intent: "take a screenshot" })
2. do_action returns IMMEDIATELY. If it matched a demo flow, the flow plays
   itself with built-in narration spoken through you automatically.
3. After calling do_action for a flow, STAY SILENT. Do NOT call do_action again.
   Do NOT interject. The runtime controls your voice during the flow.
4. You will receive "FLOW_COMPLETE: ..." messages. When you see one, wrap up in
   one or two natural sentences describing what's on screen, then ask the
   presenter what to show next.
5. If status is "not_found", no matching flow exists. Describe what you can see
   and ask the presenter to clarify.
6. If status is "suspended", the presenter is in manual control. Stay quiet.

When the session first connects:
- You will receive a "SESSION_START" message. Greet the audience.
- Introduce yourself by name (from the KNOWLEDGE BASE Identity section if available).
- Keep the greeting warm, confident, and brief (2-3 sentences max).
- End by asking the presenter what they would like to show today.
- Do NOT wait for mic input — speak immediately on SESSION_START.

Rules:
- Never mention executionId, tokens, MCP, "function call", or technical terms.
- Never describe what you are doing technically — just present naturally.
- If the browser shows something unexpected, describe what you see calmly.
- If the presenter takes manual control, wait patiently until they return control.
- Outside of flow playback, respond naturally and use the KNOWLEDGE BASE as ground truth.`;
}

// ----- audio playback queue (24 kHz PCM16) -----
function createAudioPlayer() {
  let ctx = null;
  let nextStartTime = 0;

  function ensureCtx() {
    if (!ctx) {
      const AC =
        typeof window !== 'undefined' &&
        (window.AudioContext || window.webkitAudioContext);
      if (!AC) return null;
      ctx = new AC({ sampleRate: 24000 });
      nextStartTime = 0;
    }
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  function unlock() {
    ensureCtx();
  }

  function playPcmChunk(pcmBytes, sampleRate) {
    const audioCtx = ensureCtx();
    if (!audioCtx) return;

    const view = new DataView(
      pcmBytes.buffer,
      pcmBytes.byteOffset,
      pcmBytes.byteLength
    );
    const sampleCount = Math.floor(pcmBytes.byteLength / 2);
    const float32 = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      const s = view.getInt16(i * 2, true);
      float32[i] = s / 0x8000;
    }

    const buffer = audioCtx.createBuffer(1, sampleCount, sampleRate);
    buffer.copyToChannel(float32, 0);

    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(audioCtx.destination);

    const startAt = Math.max(audioCtx.currentTime, nextStartTime);
    src.start(startAt);
    nextStartTime = startAt + buffer.duration;
  }

  function reset() {
    nextStartTime = 0;
  }

  return { playPcmChunk, reset, unlock };
}

// ----- microphone capture (16 kHz PCM16, push-to-talk) -----
function createMicCapture(onChunk) {
  let stream = null;
  let ctx = null;
  let processor = null;
  let source = null;

  async function start() {
    if (stream) return;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ sampleRate: 16000 });
    source = ctx.createMediaStreamSource(stream);
    processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        let s = Math.max(-1, Math.min(1, input[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      onChunk(new Uint8Array(pcm16.buffer));
    };
    source.connect(processor);
    processor.connect(ctx.destination);
  }

  function stop() {
    try { processor && processor.disconnect(); } catch {}
    try { source && source.disconnect(); } catch {}
    try { ctx && ctx.close(); } catch {}
    if (stream) {
      for (const t of stream.getTracks()) {
        try { t.stop(); } catch {}
      }
    }
    processor = null;
    source = null;
    ctx = null;
    stream = null;
  }

  return { start, stop };
}

// ===================================================================

function useGeminiSession({ apiKey, knowledge, flows, sections, onMessage }) {
  const [status, setStatus] = useState('disconnected');
  const [geminiStatus, setGeminiStatus] = useState('idle');
  const sessionRef = useRef(null);
  const audioPlayerRef = useRef(null);
  const micRef = useRef(null);

  // Stable refs for values that change but are read inside callbacks.
  const onMessageRef = useRef(onMessage);
  const flowsRef = useRef(flows);
  const knowledgeRef = useRef(knowledge);
  const sectionsRef = useRef(sections);
  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);
  useEffect(() => { flowsRef.current = flows; }, [flows]);
  useEffect(() => { knowledgeRef.current = knowledge; }, [knowledge]);
  useEffect(() => { sectionsRef.current = sections; }, [sections]);

  // ----- internal message handler (I/O only) -----
  const handleMessage = useCallback((message) => {
    // Audio playback.
    const parts = message.serverContent?.modelTurn?.parts;
    if (parts) {
      for (const part of parts) {
        if (part.inlineData?.data) {
          const bin = atob(part.inlineData.data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          audioPlayerRef.current?.playPcmChunk(bytes, 24000);
          setGeminiStatus('speaking');
        }
      }
    }

    if (message.serverContent?.turnComplete) {
      setGeminiStatus('listening');
    }

    // Forward everything to orchestrator.
    if (onMessageRef.current) {
      onMessageRef.current(message);
    }
  }, []);

  // ----- sendText / sendToolResponse (exposed for orchestrator binding) -----
  const sendText = useCallback((text) => {
    if (!sessionRef.current) return;
    sessionRef.current.sendClientContent({
      turns: [{ role: 'user', parts: [{ text }] }]
    });
  }, []);

  const sendToolResponse = useCallback((payload) => {
    if (!sessionRef.current) return;
    sessionRef.current.sendToolResponse(payload);
  }, []);

  // ----- connect / disconnect -----
  const connectSession = useCallback(async () => {
    if (sessionRef.current || !apiKey) return;
    setStatus('connecting');
    audioPlayerRef.current = createAudioPlayer();

    try {
      const ai = new GoogleGenAI({ apiKey });

      const session = await ai.live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: {
            parts: [
              { text: buildSystemPrompt(flowsRef.current, knowledgeRef.current, sectionsRef.current) }
            ]
          },
          tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        },
        callbacks: {
          onopen: () => {
            setStatus('connected');
            setGeminiStatus('listening');
          },
          onmessage: (msg) => handleMessage(msg),
          onerror: (e) => {
            console.error('Gemini error', e);
            setStatus('error');
          },
          onclose: () => {
            setStatus('disconnected');
            sessionRef.current = null;
          }
        }
      });

      sessionRef.current = session;

      // Trigger greeting.
      try {
        session.sendClientContent({
          turns: [
            {
              role: 'user',
              parts: [
                {
                  text: 'SESSION_START: The session just connected. Greet the audience, introduce yourself, and ask the presenter what they would like to show today.'
                }
              ]
            }
          ]
        });
      } catch (greetErr) {
        console.warn('Greeting send failed:', greetErr.message);
      }
    } catch (err) {
      console.error('Failed to connect Gemini session:', err);
      setStatus('error');
    }
  }, [apiKey, handleMessage]);

  const disconnectSession = useCallback(() => {
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch {}
      sessionRef.current = null;
    }
    if (micRef.current) {
      micRef.current.stop();
      micRef.current = null;
    }
    setStatus('disconnected');
  }, []);

  const reconnectSession = useCallback(async () => {
    disconnectSession();
    await new Promise((r) => setTimeout(r, 100));
    await connectSession();
  }, [connectSession, disconnectSession]);

  // ----- audio input -----
  const sendAudioChunk = useCallback((rawPcmBuffer) => {
    if (!sessionRef.current) return;

    let b64;
    if (typeof Buffer !== 'undefined') {
      b64 = Buffer.from(rawPcmBuffer).toString('base64');
    } else {
      let bin = '';
      for (let i = 0; i < rawPcmBuffer.length; i++)
        bin += String.fromCharCode(rawPcmBuffer[i]);
      b64 = btoa(bin);
    }

    sessionRef.current.sendRealtimeInput({
      audio: { data: b64, mimeType: 'audio/pcm;rate=16000' }
    });
  }, []);

  const startMicStream = useCallback(async () => {
    if (micRef.current) return;
    micRef.current = createMicCapture(sendAudioChunk);
    try {
      await micRef.current.start();
    } catch (err) {
      console.error('Mic start failed:', err);
      micRef.current = null;
    }
  }, [sendAudioChunk]);

  const stopMicStream = useCallback(() => {
    if (!micRef.current) return;
    micRef.current.stop();
    micRef.current = null;
  }, []);

  const unlockAudio = useCallback(() => {
    if (!audioPlayerRef.current) {
      audioPlayerRef.current = createAudioPlayer();
    }
    audioPlayerRef.current.unlock?.();
  }, []);

  // ----- spacebar push-to-talk -----
  // appMode check is removed — the caller (App.jsx) gates startListening/stopListening.
  // We just expose the raw mic controls + unlock.

  return {
    status,
    geminiStatus,
    connectSession,
    disconnectSession,
    reconnectSession,
    sendText,
    sendToolResponse,
    startMicStream,
    stopMicStream,
    unlockAudio
  };
}

module.exports = { useGeminiSession, buildSystemPrompt, FUNCTION_DECLARATIONS, MODEL };
