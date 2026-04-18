// FIFO narration queue. Sends text to Gemini one at a time, waits for
// turnComplete before sending the next. Replaces the single-slot
// pendingNarrateResolverRef pattern.
//
// Usage:
//   const q = new NarrationQueue();
//   q.bind(sendTextFn);          // wire to live session
//   await q.enqueue('Hello');    // resolves when Gemini finishes speaking
//   q.onTurnComplete();          // called by message handler on turnComplete
//   q.flush();                   // resolve all pending (disconnect/cancel)
//   q.unbind();                  // session gone

const NARRATION_TIMEOUT_MS = 30000;

class NarrationQueue {
  constructor() {
    this._queue = [];     // { text, resolve, timer }
    this._inflight = null;
    this._sendFn = null;  // (text) => void — sends text to Gemini session
  }

  bind(sendFn) {
    this._sendFn = sendFn;
  }

  unbind() {
    this.flush();
    this._sendFn = null;
  }

  enqueue(text) {
    if (!text) return Promise.resolve();

    // No session — resolve immediately (caller continues silently).
    if (!this._sendFn) return Promise.resolve();

    return new Promise((resolve) => {
      this._queue.push({ text, resolve, timer: null });
      this._drain();
    });
  }

  // Called by the session message handler when turnComplete arrives.
  onTurnComplete() {
    if (!this._inflight) return;
    this._finish(this._inflight);
    this._inflight = null;
    this._drain();
  }

  // Resolve everything immediately. Used on disconnect or flow cancellation.
  flush() {
    if (this._inflight) {
      this._finish(this._inflight);
      this._inflight = null;
    }
    while (this._queue.length > 0) {
      this._finish(this._queue.shift());
    }
  }

  // --- internals ---

  _drain() {
    if (this._inflight) return;       // already speaking
    if (this._queue.length === 0) return;

    const item = this._queue.shift();
    this._inflight = item;

    // Hard timeout — if turnComplete never arrives, don't freeze the runtime.
    item.timer = setTimeout(() => {
      if (this._inflight === item) {
        this._inflight = null;
        item.resolve();
        this._drain();
      }
    }, NARRATION_TIMEOUT_MS);

    try {
      this._sendFn(item.text);
    } catch (err) {
      console.warn('NarrationQueue: send failed:', err.message);
      this._finish(item);
      this._inflight = null;
      this._drain();
    }
  }

  _finish(item) {
    if (item.timer) {
      clearTimeout(item.timer);
      item.timer = null;
    }
    item.resolve();
  }
}

module.exports = { NarrationQueue };
