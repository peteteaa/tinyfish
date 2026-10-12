// Progress notices from deep inside a job (e.g. "Gemini is rate limited, retrying in 38s") without threading a
// callback through every call. startJob runs each job inside a context; notice() reports to that job, if any.

import { AsyncLocalStorage } from "node:async_hooks";

const current = new AsyncLocalStorage<(message: string) => void>();

export function withNotices<T>(onNotice: (message: string) => void, body: () => T): T {
  return current.run(onNotice, body);
}

/** Reports a notice to the job this code is running in. No-op outside a job (CLI, tests). */
export function notice(message: string) {
  current.getStore()?.(message);
}
