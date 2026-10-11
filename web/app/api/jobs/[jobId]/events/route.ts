import { getJob, subscribe, type JobEvent } from "@core/jobs.js";
import { apiError } from "../../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TERMINAL = new Set(["done", "error"]);

/** Server-sent events: buffered history first, then live events, until the job finishes. */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const job = getJob(jobId);
  if (!job) return apiError(404, "job_not_found", "This session has expired or never existed. Start it again from the home page.");

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        controller.close();
      };
      const send = (e: JobEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        if (TERMINAL.has(e.kind)) queueMicrotask(close);
      };
      // Comment lines keep proxies from closing an idle connection during long agent runs.
      const heartbeat = setInterval(() => !closed && controller.enqueue(encoder.encode(": keepalive\n\n")), 15_000);
      const unsubscribe = subscribe(job, send);
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.signal.addEventListener("abort", close);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
