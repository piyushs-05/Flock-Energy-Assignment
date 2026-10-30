import { setTimeout as delay } from "node:timers/promises";
import { ApiError } from "./errors.js";

export const timeoutError = () =>
  new ApiError(504, "PORTAL_TIMEOUT", "Portal request timed out.");
const operations = new WeakMap();
export function operationFor(key, timeoutMs = 30000) {
  if (!operations.has(key))
    operations.set(key, { deadline: Date.now() + timeoutMs, retries: 1 });
  return operations.get(key);
}

export class Scheduler {
  constructor(limit = 4, maxQueue = 20) {
    this.limit = limit;
    this.maxQueue = maxQueue;
    this.active = 0;
    this.queue = [];
  }
  acquire(signal) {
    if (signal?.aborted) return Promise.reject(timeoutError());
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.releaseOnce());
    }
    if (this.queue.length >= this.maxQueue)
      return Promise.reject(
        new ApiError(503, "SERVICE_BUSY", "Portal request queue is full."),
      );
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        cleanup: () => signal?.removeEventListener("abort", abort),
      };
      const abort = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        entry.cleanup();
        reject(timeoutError());
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(entry);
    });
  }
  releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        next.cleanup();
        next.resolve(this.releaseOnce());
      } else this.active--;
    };
  }
}

export function retryAfter(value, now = Date.now()) {
  if (typeof value !== "string") return undefined;
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(60, Math.max(1, Math.ceil(seconds)))
    : undefined;
}

export const backoff = (ms, signal) => delay(ms, undefined, { signal });
