import { followJob, getJob, type JobEvent } from "@core/jobs.js";
import { jobStore } from "@core/store.js";
import { apiError } from "../../../../../lib/api";
import { withUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** How long one stream stays open. EventSource reconnects after it ends and gets the full history again. */
const STREAM_MS = 270_000;

/**
 * Server-sent events: the job's history first, then live events, until the job finishes. Works from any server
 * instance: jobs on this instance stream from memory, others from the store (see followJob in src/jobs.ts).
 */
export const GET = withUser(async (request: Request, { params }: { params: Promise<{ jobId: string }> }) => {
  const { jobId } = await params;
  if (!getJob(jobId) && !(await jobStore().getJobInfo(jobId))) {
    return apiError(404, "job_not_found", "This session has expired or never existed. Start it again from the home page.");
  }

  const encoder = new TextEncoder();
  const abort = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (text: string) => !closed && controller.enqueue(encoder.encode(text));
      // Comment lines keep proxies from closing an idle connection during long agent runs.
      const heartbeat = setInterval(() => write(": keepalive\n\n"), 15_000);
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        abort.abort();
        controller.close();
      };
      request.signal.addEventListener("abort", close);
      followJob(jobId, (e: JobEvent) => write(`data: ${JSON.stringify(e)}\n\n`), { signal: abort.signal, maxMs: STREAM_MS })
        .catch((err) => write(`data: ${JSON.stringify({ kind: "error", message: `Lost track of the job: ${err instanceof Error ? err.message : err}` })}\n\n`))
        .finally(close);
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
});
