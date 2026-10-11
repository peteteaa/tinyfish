"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";

export interface RepairRequest {
  runId: string;
  step: string;
}
type Handler = (r: RepairRequest) => Promise<void>;

interface RepairApi {
  /** The chat editor registers itself as the handler; repairs show up in its conversation. */
  register(h: Handler | null): void;
  request(r: RepairRequest): void;
  pending: RepairRequest | null;
}

const Ctx = createContext<RepairApi | null>(null);

/** Connects "Repair this step" buttons (run panel, run history) to the workflow editor on the same page. */
export function RepairProvider({ children }: { children: React.ReactNode }) {
  const handler = useRef<Handler | null>(null);
  const [pending, setPending] = useState<RepairRequest | null>(null);
  const busy = useRef(false);

  const register = useCallback((h: Handler | null) => {
    handler.current = h;
  }, []);
  const request = useCallback((r: RepairRequest) => {
    const h = handler.current;
    if (!h || busy.current) return;
    busy.current = true;
    setPending(r);
    h(r).finally(() => {
      busy.current = false;
      setPending(null);
    });
  }, []);

  return <Ctx.Provider value={{ register, request, pending }}>{children}</Ctx.Provider>;
}

export function useRepair(): RepairApi | null {
  return useContext(Ctx);
}

export function RepairButton({ runId, step, compact }: RepairRequest & { compact?: boolean }) {
  const repair = useRepair();
  if (!repair) return null;
  const mine = repair.pending?.runId === runId && repair.pending.step === step;
  return (
    <button
      type="button"
      className={compact ? "link-button" : undefined}
      disabled={repair.pending !== null}
      onClick={() => repair.request({ runId, step })}
      aria-label={compact ? `Repair ${step}` : undefined}
    >
      {mine ? "Repairing…" : compact ? "Repair" : "Repair this step"}
    </button>
  );
}
