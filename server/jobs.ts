import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { Cell, KeyValue, columnAffinitySchema } from "../shared/contracts";

type ColumnAffinity = z.infer<typeof columnAffinitySchema>;
import type { z } from "zod";
import { encodingPrologue } from "../shared/cell-encoding";
import type { jobResultSchema, jobStartInputSchema, jobStateSchema } from "../shared/contracts";
import { classifySqliteError, type DatabaseEntry, type SqliteEngine } from "./engine";
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

/**
 * The worker runs arbitrary SQL away from the plugin thread: a slow sort or a
 * full scan would otherwise stall every other RPC in this plugin.
 *
 * The cell helpers are embedded from `shared/cell-encoding.ts` by function source,
 * so both sides encode values identically without a second copy of the rules.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
${encodingPrologue()}
const startedAt = Date.now();
try {
  const db = new DatabaseSync(workerData.path, { readOnly: true, timeout: 750 });
  const statement = db.prepare(workerData.sql);
  if (typeof statement.setReadBigInts === "function") statement.setReadBigInts(true);
  const declared = typeof statement.columns === "function"
    ? statement.columns().filter((column) => column.name !== null)
    : [];
  const returnsRows = declared.length > 0 || /^\\s*(select|with|pragma|explain|values)\\b/i.test(workerData.sql);
  if (!returnsRows) {
    const outcome = statement.run();
    db.close();
    parentPort.postMessage({
      ok: true,
      returnedRows: false,
      changes: outcome.changes === undefined ? null : Number(outcome.changes),
      columns: [],
      rows: [],
      hasMore: false,
      budgetExceeded: false,
      elapsedMs: Date.now() - startedAt,
    });
  } else {
    const rows = [];
    const keys = [];
    let names = declared.map((column) => column.name);
    let hasMore = false;
    let budgetExceeded = false;
    for (const row of statement.iterate()) {
      if (rows.length >= workerData.limit) { hasMore = true; break; }
      if (names.length === 0) names = Object.keys(row);
      rows.push(names.map((name) => encodeCell(row[name])));
      keys.push([]);
      if (Date.now() - startedAt > workerData.budgetMs) { budgetExceeded = true; hasMore = true; break; }
    }
    db.close();
    parentPort.postMessage({
      ok: true,
      returnedRows: true,
      changes: null,
      columns: names.map((name) => {
        const declaredColumn = declared.find((column) => column.name === name);
        const declaredType = declaredColumn ? (declaredColumn.type || "") : "";
        return { name, declaredType, affinity: affinityOf(declaredType) };
      }),
      rows,
      keys,
      hasMore,
      budgetExceeded,
      elapsedMs: Date.now() - startedAt,
    });
  }
} catch (error) {
  parentPort.postMessage({ ok: false, error: error && error.message ? error.message : String(error) });
}
`;

interface WorkerReply {
  ok: boolean;
  error?: string;
  returnedRows?: boolean;
  changes?: number | null;
  columns?: Array<{ name: string; declaredType: string; affinity: ColumnAffinity }>;
  /** Encoded by the embedded shared helpers, so these are real cells. */
  rows?: Cell[][];
  keys?: KeyValue[][];
  hasMore?: boolean;
  budgetExceeded?: boolean;
  elapsedMs?: number;
}

interface JobRecord {
  status: JobStatus;
  worker: Worker | null;
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
    // A job reads the same file the handle reads; snapshots are read from their copy.
    const path = entry.snapshotPath ?? entry.path;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { path, sql: request.sql, limit: request.limit, budgetMs: WORKER_TIME_BUDGET_MS },
    });
    record.worker = worker;

    const timeout = setTimeout(() => {
      record.status.error = `The query ran longer than ${Math.round(JOB_TIMEOUT_MS / 60000)} minutes and was cancelled.`;
      record.cancel();
    }, JOB_TIMEOUT_MS);
    timeout.unref();

    let settled = false;
    const settle = (result: JobResult | null, error: string | null, state: JobState) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      this.#finish(record, result, error, state);
    };

    record.cancel = () => {
      void worker.terminate();
      settle(null, "Cancelled.", "cancelled");
    };

    worker.on("message", (reply: WorkerReply) => {
      if (!reply.ok) {
        settle(null, reply.error ?? "The query failed.", "failed");
        void worker.terminate();
        return;
      }
      settle(
        {
          kind: "sql",
          budgetExceeded: reply.budgetExceeded === true,
          changes: reply.changes ?? null,
          result: {
            columns: reply.columns ?? [],
            rows: reply.rows ?? [],
            keys: reply.keys ?? [],
            hasMore: reply.hasMore === true,
            rowCount: null,
            nextCursor: null,
            elapsedMs: reply.elapsedMs ?? 0,
            sql: request.sql,
          },
        },
        null,
        "done",
      );
      void worker.terminate();
    });
    worker.on("error", (error) => {
      settle(null, classifySqliteError(error).message, "failed");
    });
    worker.on("exit", (code) => {
      if (!settled) settle(null, code === 0 ? "The query stopped without returning a result." : `The query worker exited with code ${code}.`, "failed");
    });
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
