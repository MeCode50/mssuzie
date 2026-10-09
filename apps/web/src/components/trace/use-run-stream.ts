"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { initialTrace, reduceTrace, type RunStatus, type StepData } from "@/lib/trace";

/**
 * idle: no run yet. connecting/live: streaming. reconnecting: the browser is retrying and will resume
 * after the last step it saw. ended: the run finished. expired: signed out. lost: gave up (see message).
 */
export type Connection = "idle" | "connecting" | "live" | "reconnecting" | "ended" | "expired" | "lost";

/** Subscribe to a run's live events. The browser's EventSource reconnects by itself and resumes from the last event id. */
export function useRunStream(runId: string | null) {
  const [state, dispatch] = useReducer(reduceTrace, undefined, initialTrace);
  const [connection, setConnection] = useState<Connection>("idle");
  const [generation, setGeneration] = useState(0);
  const lastSeq = useRef(0);
  useEffect(() => void (lastSeq.current = state.lastSeq), [state.lastSeq]);

  useEffect(() => {
    if (!runId) {
      setConnection("idle");
      return;
    }
    setConnection("connecting");
    // A fresh EventSource (after Retry) does not send Last-Event-ID, so resume explicitly.
    const after = lastSeq.current > 0 ? `?after=${lastSeq.current}` : "";
    const source = new EventSource(`/api/runs/${runId}/events${after}`);
    const data = <T,>(e: Event): T => JSON.parse((e as MessageEvent<string>).data) as T;

    source.addEventListener("open", () => setConnection("live"));
    source.addEventListener("step", (e) => dispatch({ type: "step", data: data<StepData>(e), receivedAt: Date.now() }));
    source.addEventListener("run", (e) => dispatch({ type: "run", data: data<never>(e) }));
    source.addEventListener("done", (e) => {
      dispatch({ type: "done", data: data<{ status: RunStatus }>(e) });
      setConnection("ended");
      source.close();
    });
    source.addEventListener("error", () => {
      if (source.readyState !== EventSource.CLOSED) return setConnection("reconnecting");
      // The server refused the stream (or the network is gone for good): find out why.
      fetch(`/api/runs/${runId}`, { credentials: "same-origin" })
        .then((r) => setConnection(r.status === 401 ? "expired" : "lost"))
        .catch(() => setConnection("lost"));
    });
    return () => source.close();
  }, [runId, generation]);

  /** Open a new stream (after Retry); steps already applied are skipped. */
  const restart = useCallback(() => setGeneration((g) => g + 1), []);
  const reset = useCallback(() => dispatch({ type: "reset" }), []);
  return { state, connection, restart, reset };
}
