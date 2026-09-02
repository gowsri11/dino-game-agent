// Minimal event bus. The app had no event system, only a log() call in main.js,
// so this stays deliberately small: subscribe, emit, and a bounded history.
export class EventBus {
  constructor(historyLimit = 200) {
    this.listeners = new Set();
    this.history = [];
    this.historyLimit = historyLimit;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, data = {}) {
    const event = { type, at: Date.now(), ...data };
    this.history.push(event);
    if (this.history.length > this.historyLimit) this.history.shift();
    for (const fn of this.listeners) {
      try { fn(event); } catch (err) { console.error("[events]", type, err); }
    }
    return event;
  }
}
