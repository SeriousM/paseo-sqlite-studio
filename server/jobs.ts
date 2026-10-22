import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { Cell, KeyValue, columnAffinitySchema } from "../shared/contracts";

type ColumnAffinity = z.infer<typeof columnAffinitySchema>;
import type { z } from "zod";
import { encodingPrologue } from "../shared/cell-encoding";
import type { jobResultSchema, jobStartInputSchema, jobStateSchema } from "../shared/contracts";
import { classifySqliteError, type DatabaseEntry, type SqliteEngine } from "./engine";
import { runQueriesInWorker, type WorkerRun } from "./sql-worker";
import { writeExport } from "./export";

type JobResult = z.infer<typeof jobResultSchema>;
type JobState = z.infer<typeof jobStateSchema>;
type JobRequest = z.infer<typeof jobStartInputSchema>;

export interface JobStatus {
  jobId: string;
  kind: JobRequest["kind"];
  state: JobState;
  startedAt: number;
  elapsedMs: number;
  result: JobResult | null;
  error: string | null;
}

/** Wall-clock ceiling for one job; a runaway query is cancelled, not queued forever. */
const JOB_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RUNNING_JOBS = 4;
const RETAINED_JOBS = 20;
/** Rows a worker may accumulate before it reports a partial result. */
const WORKER_TIME_BUDGET_MS = 20_000;

interface JobRecord {
  status: JobStatus;
  worker: WorkerRun | null;
  cancel: () => void;
}

export class JobRegistry {
  readonly #jobs = new Map<string, JobRecord>();

  constructor(private readonly engine: SqliteEngine) {}

  start(request: JobRequest): { jobId: string } {
    this.#prune();
    const running = [...this.#jobs.values()].filter((job) => job.status.state === "running").length;
    if (running >= MAX_RUNNING_JOBS) {
      throw new Error(`Too many jobs are running (${running}). Wait for one to finish or cancel it.`);
    }
    const jobId = createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 16);
    const record: JobRecord = {
      status: {
        jobId,
        kind: request.kind,
        state: "running",
        startedAt: Date.now(),
        elapsedMs: 0,
        result: null,
        error: null,
      },
      worker: null,
      cancel: () => {},
    };
    this.#jobs.set(jobId, record);

    const entry = this.engine.get(request.handleId);
    if (request.kind === "sql") {
      void this.#runSqlJob(record, entry, request);
    } else {
      void this.#runExportJob(record, entry, request);
    }
    return { jobId };
  }

  poll(jobId: string): JobStatus {
    const record = this.#jobs.get(jobId);
    if (!record) throw new Error("That job is no longer tracked. Start it again.");
    if (record.status.state === "running") record.status.elapsedMs = Date.now() - record.status.startedAt;
    return { ...record.status };
  }

  cancel(jobId: string): boolean {
    const record = this.#jobs.get(jobId);
    if (!record) return false;
    if (record.status.state !== "running") return false;
    record.cancel();
    return true;
  }

  dispose(): void {
    for (const record of this.#jobs.values()) {
      if (record.status.state === "running") record.cancel();
    }
    this.#jobs.clear();
  }

  #prune(): void {
    const finished = [...this.#jobs.entries()]
      .filter(([, record]) => record.status.state !== "running")
      .sort((left, right) => left[1].status.startedAt - right[1].status.startedAt);
    for (const [jobId] of finished.slice(0, Math.max(0, finished.length - RETAINED_JOBS))) {
      this.#jobs.delete(jobId);
    }
  }

  #finish(record: JobRecord, result: JobResult | null, error: string | null, state: JobState): void {
    record.status.state = state;
    record.status.result = result;
    record.status.error = error;
    record.status.elapsedMs = Date.now() - record.status.startedAt;
    record.worker = null;
  }

  async #runSqlJob(record: JobRecord, entry: DatabaseEntry, request: Extract<JobRequest, { kind: "sql" }>): Promise<void> {
    const run = runQueriesInWorker({
      // A job reads the same file the handle reads; snapshots are read from their copy.
      path: entry.snapshotPath ?? entry.path,
      queries: [
        {
          id: "query",
          sql: request.sql,
          params: [],
          limit: request.limit,
          rowColumns: [],
          keyColumns: [],
          cursorColumns: [],
          budgetMs: WORKER_TIME_BUDGET_MS,
        },
      ],
      ceilingMs: JOB_TIMEOUT_MS,
    });
    record.worker = run;
    record.cancel = () => {
      run.terminate();
      this.#finish(record, null, "Cancelled.", "cancelled");
    };

    try {
      const result = (await run.result).query;
      if (!result) throw new Error("The query returned no result.");
      this.#finish(
        record,
        {
          kind: "sql",
          budgetExceeded: result.budgetExceeded,
          changes: result.changes,
          result: {
            columns: result.columns,
            rows: result.rows,
            keys: result.keys,
            hasMore: result.hasMore,
            rowCount: null,
            nextCursor: null,
            elapsedMs: result.elapsedMs,
            sql: request.sql,
          },
        },
        null,
        "done",
      );
    } catch (error) {
      if (record.status.state === "cancelled") return;
      const message = error instanceof Error ? error.message : String(error);
      this.#finish(record, null, classifySqliteError(error).message || message, "failed");
    }
  }

  async #runExportJob(
    record: JobRecord,
    entry: DatabaseEntry,
    request: Extract<JobRequest, { kind: "export" }>,
  ): Promise<void> {
    const signal = { cancelled: false };
    record.cancel = () => {
      signal.cancelled = true;
      record.status.error = "Cancelled.";
    };
    try {
      const outcome = await writeExport(entry.db, request, signal);
      if (signal.cancelled) {
        this.#finish(record, null, "Cancelled.", "cancelled");
        return;
      }
      this.#finish(record, { kind: "export", ...outcome }, null, "done");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#finish(record, null, message, signal.cancelled ? "cancelled" : "failed");
    }
  }
}
