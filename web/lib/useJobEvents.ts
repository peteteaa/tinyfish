"use client";

import { useEffect, useState } from "react";
import type { LearnEvent } from "./learnEvents";

export type JobStatus = "connecting" | "open" | "closed" | "not_found" | "lost";

export function useJobEvents(jobId: string): { events: LearnEvent[]; status: JobStatus } {
  const [events, setEvents] = useState<LearnEvent[]>([]);
  const [status, setStatus] = useState<JobStatus>("connecting");

  useEffect(() => {
    let finished = false;
    let gotAny = false;
    setEvents([]);
    setStatus("connecting");
    const es = new EventSource(`/api/jobs/${jobId}/events`);

    es.onopen = () => {
      // The server replays full history on every (re)connect.
      gotAny = false;
      setEvents([]);
      setStatus("open");
    };
    es.onmessage = (m) => {
      let ev: LearnEvent;
      try {
        ev = JSON.parse(m.data) as LearnEvent;
      } catch {
        return;
      }
      gotAny = true;
      setEvents((prev) => [...prev, ev]);
      if (ev.kind === "done" || ev.kind === "error") {
        finished = true;
        es.close();
        setStatus("closed");
      }
    };
    es.onerror = () => {
      if (finished) return;
      if (!gotAny) {
        es.close();
        fetch(`/api/jobs/${jobId}/events`)
          .then((r) => {
            void r.body?.cancel();
            setStatus(r.status === 404 ? "not_found" : "lost");
          })
          .catch(() => setStatus("lost"));
      } else {
        // EventSource keeps retrying; surface it, onopen will restore.
        setStatus("lost");
      }
    };
    return () => {
      finished = true;
      es.close();
    };
  }, [jobId]);

  return { events, status };
}
