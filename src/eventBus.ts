import { EventEmitter } from "node:events";

import type { TdlibEvent } from "./types.js";

export class SessionEventBus {
  private readonly emitters = new Map<string, EventEmitter>();

  emit(event: TdlibEvent): void {
    const emitter = this.emitters.get(event.sessionId);
    if (!emitter) {
      return;
    }
    emitter.emit("event", event);
  }

  subscribe(sessionId: string, listener: (event: TdlibEvent) => void): () => void {
    const emitter = this.getOrCreate(sessionId);
    emitter.on("event", listener);
    return () => {
      emitter.off("event", listener);
    };
  }

  clear(sessionId: string): void {
    const emitter = this.emitters.get(sessionId);
    if (emitter) {
      emitter.removeAllListeners();
      this.emitters.delete(sessionId);
    }
  }

  private getOrCreate(sessionId: string): EventEmitter {
    const existing = this.emitters.get(sessionId);
    if (existing) {
      return existing;
    }
    const emitter = new EventEmitter();
    this.emitters.set(sessionId, emitter);
    return emitter;
  }
}
