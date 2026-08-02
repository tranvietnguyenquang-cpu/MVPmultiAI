export interface ExecutionClock {
  now(): Date;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export class SystemExecutionClock implements ExecutionClock {
  now(): Date { return new Date(); }

  sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, Math.max(0, milliseconds));
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  }
}

export class ImmediateExecutionClock implements ExecutionClock {
  private current: Date;
  constructor(start = new Date("2026-08-02T00:00:00.000Z")) { this.current = start; }
  now(): Date { return new Date(this.current); }
  async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    this.current = new Date(this.current.getTime() + Math.max(0, milliseconds));
  }
}
