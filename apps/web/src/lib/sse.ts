import type { PrismaClient } from "@mssuzie/core";
import { stepView } from "./runs";
import { ApiError } from "./errors";

const TERMINAL = new Set(["completed", "partial", "failed"]);
const encoder = new TextEncoder();

export interface SseOptions {
  /** How often to look for new steps. */
  pollMs?: number;
  /** Comment line to keep proxies from closing an idle stream. */
  heartbeatMs?: number;
  /** Close after this long; EventSource reconnects and resumes from its last seq. */
  maxMs?: number;
}

export const SSE_DEFAULTS = { pollMs: 500, heartbeatMs: 15_000, maxMs: 55_000 } as const;

const frame = (event: string, data: unknown, id?: number): Uint8Array =>
  encoder.encode(`${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

/**
 * Server-sent events for one run: replay every step after `afterSeq`, then poll for new ones.
 * Events: `step` (id = seq), `run` (status changes), `done` (terminal and fully flushed).
 * The run status is read BEFORE the steps, so a terminal status can only be reported once every
 * step written before it has been sent.
 */
export function createEventStream(args: {
  prisma: PrismaClient;
  runId: string;
  afterSeq: number;
  signal: AbortSignal;
} & SseOptions): ReadableStream<Uint8Array> {
  const { prisma, runId, signal } = args;
  const pollMs = args.pollMs ?? SSE_DEFAULTS.pollMs;
  const heartbeatMs = args.heartbeatMs ?? SSE_DEFAULTS.heartbeatMs;
  const maxMs = args.maxMs ?? SSE_DEFAULTS.maxMs;
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  signal.addEventListener("abort", onAbort);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const started = Date.now();
      let last = args.afterSeq;
      let lastStatus: string | null = null;
      let lastBeat = Date.now();
      const send = (chunk: Uint8Array) => {
        if (!stop.signal.aborted) controller.enqueue(chunk);
      };
      try {
        send(encoder.encode("retry: 2000\n\n"));
        while (!stop.signal.aborted) {
          const run = await prisma.run.findUnique({
            where: { id: runId }, select: { status: true, totalTokens: true, costUsd: true, startedAt: true, finishedAt: true },
          });
          if (!run) break; // the run was deleted (demo reset)
          const steps = await prisma.runStep.findMany({
            where: { runId, seq: { gt: last } }, orderBy: { seq: "asc" }, take: 200,
          });
          for (const s of steps) {
            send(frame("step", stepView(s), s.seq));
            last = s.seq;
          }
          if (run.status !== lastStatus) {
            send(frame("run", { status: run.status, totalTokens: run.totalTokens, costUsd: Number(run.costUsd), startedAt: run.startedAt, finishedAt: run.finishedAt }));
            lastStatus = run.status;
          }
          if (steps.length === 0 && TERMINAL.has(run.status)) {
            send(frame("done", { status: run.status }));
            break;
          }
          if (Date.now() - started > maxMs) break;
          if (steps.length === 0) {
            if (Date.now() - lastBeat >= heartbeatMs) {
              send(encoder.encode(": ping\n\n"));
              lastBeat = Date.now();
            }
            await sleep(pollMs, stop.signal);
          }
        }
      } catch {
        // A closed controller (client gone) or a transient DB error ends this stream; the browser reconnects.
      } finally {
        signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      stop.abort();
      signal.removeEventListener("abort", onAbort);
    },
  });
}

/** Per-instance cap on simultaneous streams for one user (each stream polls the database). */
const MAX_STREAMS_PER_USER = 6;
const open = new Map<string, number>();

export function acquireStreamSlot(userId: string): () => void {
  const n = open.get(userId) ?? 0;
  if (n >= MAX_STREAMS_PER_USER) {
    throw new ApiError(429, "rate_limited", "You have too many live views open. Close one and try again.", { "retry-after": "5" });
  }
  open.set(userId, n + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (open.get(userId) ?? 1) - 1;
    if (left <= 0) open.delete(userId);
    else open.set(userId, left);
  };
}

export const openStreamCount = (userId: string): number => open.get(userId) ?? 0;

/** Resume point: the standard Last-Event-ID header (sent by EventSource on reconnect) or ?after=. */
export function resumeSeq(req: Request): number {
  const raw = req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("after");
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}
