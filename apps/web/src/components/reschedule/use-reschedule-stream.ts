"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { initialRTrace, reduceRTrace, type RStepData, type RunStatus } from "@/lib/reschedule-trace";
import type { Connection } from "@/components/trace/use-run-stream";

/** Subscribe to a rescheduling run's live events (same endpoint and reconnect rules as the session trace). */
export function useRescheduleStream(runId: string | null) {
  const [state, dispatch] = useReducer(reduceRTrace, undefined, initialRTrace);
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
    const after = lastSeq.current > 0 ? `?after=${lastSeq.current}` : "";
    const source = new EventSource(`/api/runs/${runId}/events${after}`);
    const data = <T,>(e: Event): T => JSON.parse((e as MessageEvent<string>).data) as T;
    source.addEventListener("open", () => setConnection("live"));
    source.addEventListener("step", (e) => dispatch({ type: "step", data: data<RStepData>(e), receivedAt: Date.now() }));
    source.addEventListener("run", (e) => dispatch({ type: "run", data: data<never>(e) }));
    source.addEventListener("done", (e) => {
      dispatch({ type: "done", data: data<{ status: RunStatus }>(e) });
      setConnection("ended");
      source.close();
    });
    source.addEventListener("error", () => {
      if (source.readyState !== EventSource.CLOSED) return setConnection("reconnecting");
      fetch(`/api/reschedules`, { credentials: "same-origin" })
        .then((r) => setConnection(r.status === 401 ? "expired" : "lost"))
        .catch(() => setConnection("lost"));
    });
    return () => source.close();
  }, [runId, generation]);

  const restart = useCallback(() => setGeneration((g) => g + 1), []);
  const reset = useCallback(() => dispatch({ type: "reset" }), []);
  return { state, connection, restart, reset };
}
