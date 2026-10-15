// Progress notices from deep inside a job (e.g. "Gemini is rate limited, retrying in 38s") without threading a
// callback through every call. startJob runs each job inside a context; notice() reports to that job, if any.
// The context also carries the job's stop signal, aborted when the job reaches its time limit (see startJob), so
// long calls (TinyFish agent runs) can stop and cancel paid work instead of running on after the job is over.

import { AsyncLocalStorage } from "node:async_hooks";

const current = new AsyncLocalStorage<{ notice: (message: string) => void; signal?: AbortSignal }>();

export function withNotices<T>(onNotice: (message: string) => void, body: () => T, signal?: AbortSignal): T {
  return current.run({ notice: onNotice, signal }, body);
}

/** Reports a notice to the job this code is running in. No-op outside a job (CLI, tests). */
export function notice(message: string) {
  current.getStore()?.notice(message);
}

/** The running job's stop signal. Undefined outside a job, or for a job without a time limit. */
export function jobSignal(): AbortSignal | undefined {
  return current.getStore()?.signal;
}
