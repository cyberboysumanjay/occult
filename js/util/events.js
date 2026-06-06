// Minimal event emitter. on() returns a dispose function.

export function createEmitter() {
  const listeners = new Map(); // event -> Set<fn>
  return {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(payload); } catch (e) { console.error(`[emitter] ${event}`, e); }
      }
    },
  };
}
