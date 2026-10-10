import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import {
  claimRun, errorFields, executeAnyRun, type RescheduleDeps, LockLostError, releaseRun, requeueStuckRuns, STUCK_AFTER_MS,
  sweepExpiredTokenMaps, touchLock,
  type LlmConfig, type Logger, type PrismaClient, type RunSummary,
} from "@mssuzie/core";

export interface WorkerOptions {
  prisma: PrismaClient;
  llm: LlmConfig;
  encryptionKey: string;
  logger: Logger;
  workerId?: string;
  /** Number of runs processed at once by this process. */
  concurrency?: number;
  /** How often an idle slot looks for queued runs. */
  pollIntervalMs?: number;
  /** How often a running run's lock is refreshed. Must be well under stuckAfterMs. */
  heartbeatMs?: number;
  /** How often stuck-run recovery and the token-map sweep run. */
  maintenanceMs?: number;
  stuckAfterMs?: number;
  /** On stop(), how long to let in-flight runs finish before handing them back to the queue. */
  shutdownGraceMs?: number;
  /** Reschedule notice policy in hours (for rescheduling runs). */
  minNoticeHours?: number;
  /** The calendar and mailer rescheduling runs act through. */
  reschedule: Pick<RescheduleDeps, "calendar" | "mailer" | "linkSecret" | "baseUrl">;
  /** Injectable for tests. */
  execute?: (deps: RescheduleDeps, runId: string) => Promise<RunSummary>;
}

const MAX_BACKOFF_MS = 30_000;

export class Worker {
  readonly id: string;
  private readonly o: Required<Omit<WorkerOptions, "workerId" | "execute" | "minNoticeHours">> & Pick<WorkerOptions, "execute" | "minNoticeHours">;
  private stopping = false;
  private readonly sleepers = new Set<() => void>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private slots: Promise<void>[] = [];
  private maintenanceTimer: NodeJS.Timeout | null = null;

  constructor(options: WorkerOptions) {
    this.id = options.workerId ?? `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
    this.o = {
      concurrency: 1, pollIntervalMs: 1000, heartbeatMs: 30_000, maintenanceMs: 60_000,
      stuckAfterMs: STUCK_AFTER_MS, shutdownGraceMs: 60_000, ...options,
    };
  }

  get activeRuns(): string[] {
    return [...this.inFlight.keys()];
  }

  start(): void {
    const { concurrency, maintenanceMs, pollIntervalMs } = this.o;
    this.o.logger.info("worker started", {
      workerId: this.id, concurrency, pollIntervalMs, mock: this.o.llm.mock,
      models: this.o.llm.models,
    });
    this.slots = Array.from({ length: concurrency }, () => this.loop());
    this.maintenanceTimer = setInterval(() => void this.maintain(), maintenanceMs);
    void this.maintain();
  }

  /**
   * Stop claiming, let in-flight runs finish for up to shutdownGraceMs, then hand any still
   * running back to the queue so another worker can resume them (finished steps are reused).
   */
  async stop(): Promise<{ released: string[] }> {
    this.stopping = true;
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    for (const wake of this.sleepers) wake();
    this.o.logger.info("worker stopping", { workerId: this.id, inFlight: this.activeRuns.length });

    let graceTimer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      Promise.allSettled(this.slots).then(() => "drained" as const),
      new Promise<"timeout">((resolve) => {
        graceTimer = setTimeout(() => resolve("timeout"), this.o.shutdownGraceMs);
      }),
    ]);
    clearTimeout(graceTimer);

    const released: string[] = [];
    if (outcome === "timeout") {
      for (const runId of this.activeRuns) {
        if (await releaseRun(this.o.prisma, runId, this.id).catch(() => false)) released.push(runId);
      }
      this.o.logger.warn("grace period elapsed; released in-flight runs", { workerId: this.id, released });
    }
    this.o.logger.info("worker stopped", { workerId: this.id, released: released.length });
    return { released };
  }

  private async loop(): Promise<void> {
    let backoff = 0;
    while (!this.stopping) {
      try {
        const claimed = await claimRun(this.o.prisma, this.id);
        backoff = 0;
        if (!claimed) {
          await this.sleep(this.o.pollIntervalMs);
          continue;
        }
        const work = this.process(claimed.id);
        this.inFlight.set(claimed.id, work);
        await work;
      } catch (err) {
        backoff = Math.min(backoff === 0 ? 1000 : backoff * 2, MAX_BACKOFF_MS);
        this.o.logger.error("queue error; backing off", { workerId: this.id, backoffMs: backoff, ...errorFields(err) });
        await this.sleep(backoff);
      }
    }
  }

  private async process(runId: string): Promise<void> {
    const log = this.o.logger.child({ runId, workerId: this.id });
    const heartbeat = setInterval(() => {
      touchLock(this.o.prisma, runId, this.id)
        .then((held) => held || log.warn("lost the lock on a running run"))
        .catch((err: unknown) => log.warn("heartbeat failed", errorFields(err)));
    }, this.o.heartbeatMs);
    try {
      log.info("run claimed");
      const execute = this.o.execute ?? executeAnyRun;
      const summary = await execute(
        {
          prisma: this.o.prisma, llm: this.o.llm, encryptionKey: this.o.encryptionKey, lockedBy: this.id, minNoticeHours: this.o.minNoticeHours, ...this.o.reschedule,
          onEvent: (e) =>
            log.info("step", {
              agent: e.agent, status: e.status, attempt: e.attempt, tokensIn: e.tokensIn,
              tokensOut: e.tokensOut, durationMs: e.durationMs, costUsd: e.costUsd,
            }),
        },
        runId,
      );
      log.info("run finished", {
        outcome: summary.outcome, totalTokens: summary.totalTokens, costUsd: summary.costUsd,
        failedAgents: Object.keys(summary.failures),
      });
    } catch (err) {
      if (err instanceof LockLostError) log.warn("run abandoned: lock lost", errorFields(err));
      else log.error("run crashed", errorFields(err));
    } finally {
      clearInterval(heartbeat);
      this.inFlight.delete(runId);
    }
  }

  private async maintain(): Promise<void> {
    try {
      const stuck = await requeueStuckRuns(this.o.prisma, { olderThanMs: this.o.stuckAfterMs });
      if (stuck.requeued.length > 0) this.o.logger.warn("re-queued stuck runs", { runIds: stuck.requeued });
      if (stuck.failed.length > 0) this.o.logger.error("failed runs that kept crashing workers", { runIds: stuck.failed });
      const swept = await sweepExpiredTokenMaps(this.o.prisma);
      if (swept > 0) this.o.logger.info("deleted expired token maps", { count: swept });
    } catch (err) {
      this.o.logger.error("maintenance failed", errorFields(err));
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.sleepers.add(done);
    });
  }
}
