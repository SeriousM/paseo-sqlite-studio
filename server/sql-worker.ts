import { Worker } from "node:worker_threads";
import type { z } from "zod";
import { encodingPrologue } from "../shared/cell-encoding";
import type { Cell, KeyValue, columnAffinitySchema } from "../shared/contracts";

type ColumnAffinity = z.infer<typeof columnAffinitySchema>;

/**
 * Runs read-only statements away from the plugin thread: a slow sort, a full scan,
 * or a count over a large table would otherwise stall every other RPC in this plugin.
 *
 * The cell and key helpers are embedded by function source, so the worker encodes
 * values exactly like the plugin thread without a second copy of the rules. Rows carry
 * only the columns the caller asked for, which keeps keys (a rowid or primary key)
 * from leaking into the payload.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
${encodingPrologue()}
try {
  const db = new DatabaseSync(workerData.path, { readOnly: true, timeout: 750 });
  const results = {};
  for (const query of workerData.queries) {
    const startedAt = Date.now();
    const statement = db.prepare(query.sql);
    if (typeof statement.setReadBigInts === "function") statement.setReadBigInts(true);
    const declared = typeof statement.columns === "function"
      ? statement.columns().filter((column) => column.name !== null)
      : [];
    const returnsRows = declared.length > 0 || /^\\s*(select|with|pragma|explain|values)\\b/i.test(query.sql);
    if (!returnsRows) {
      const outcome = statement.run(...query.params);
      results[query.id] = {
        columns: [],
        rows: [],
        keys: [],
        hasMore: false,
        budgetExceeded: false,
        changes: outcome.changes === undefined ? null : Number(outcome.changes),
        elapsedMs: Date.now() - startedAt,
      };
      continue;
    }
    const rows = [];
    const keys = [];
    let names = declared.map((column) => column.name);
    let hasMore = false;
    let budgetExceeded = false;
    const keyColumns = query.keyColumns || [];
    // An empty list means the caller wants every column the statement returns.
    const rowColumns = query.rowColumns && query.rowColumns.length > 0 ? query.rowColumns : names;
    for (const row of statement.iterate(...query.params)) {
      if (query.limit !== null && rows.length >= query.limit) {
        hasMore = true;
        break;
      }
      if (names.length === 0) names = Object.keys(row);
      rows.push(rowColumns.map((name) => encodeCell(row[name])));
      keys.push(keyColumns.map((name) => encodeKey(row[name])));
      if (Date.now() - startedAt > query.budgetMs) {
        budgetExceeded = true;
        hasMore = true;
        break;
      }
    }
    results[query.id] = {
      columns: names.map((name) => {
        const declaredColumn = declared.find((candidate) => candidate.name === name);
        const declaredType = declaredColumn ? (declaredColumn.type || "") : "";
        return { name, declaredType, affinity: affinityOf(declaredType) };
      }),
      rows,
      keys,
      hasMore,
      budgetExceeded,
      changes: null,
      elapsedMs: Date.now() - startedAt,
    };
  }
  db.close();
  parentPort.postMessage({ ok: true, results });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error && error.message ? error.message : String(error) });
}
`;

export interface WorkerQuery {
  id: string;
  sql: string;
  params: readonly unknown[];
  /** `null` runs the statement to the end; a number caps the rows the worker collects. */
  limit: number | null;
  /** Columns of the row payload, in the order the client expects them. */
  rowColumns: readonly string[];
  /** Columns whose values come back as row keys, encoded losslessly. */
  keyColumns: readonly string[];
  /** Milliseconds a single query may scan before it reports a partial result. */
  budgetMs: number;
}

export interface WorkerQueryResult {
  columns: Array<{ name: string; declaredType: string; affinity: ColumnAffinity }>;
  rows: Cell[][];
  keys: KeyValue[][];
  hasMore: boolean;
  budgetExceeded: boolean;
  changes: number | null;
  elapsedMs: number;
}

interface WorkerReply {
  ok: boolean;
  error?: string;
  results?: Record<string, WorkerQueryResult>;
}

export interface WorkerRun {
  result: Promise<Record<string, WorkerQueryResult>>;
  terminate: () => void;
  /** True once the worker has been stopped, so callers can ignore late errors. */
  isStopped: () => boolean;
}

/**
 * Starts one worker for a batch of queries against the same file. The plugin thread
 * stays free while the worker reads, and the ceiling bounds work that never returns.
 */
export function runQueriesInWorker(options: {
  path: string;
  queries: readonly WorkerQuery[];
  ceilingMs: number;
}): WorkerRun {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { path: options.path, queries: options.queries },
  });
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const result = new Promise<Record<string, WorkerQueryResult>>((resolve, reject) => {
    const stop = (error: Error, terminate: boolean) => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      if (terminate) void worker.terminate();
      reject(error);
    };

    timer = setTimeout(() => {
      stop(new Error(`This query did not finish within ${Math.round(options.ceilingMs / 1000)} seconds. Add a filter or sort by an indexed column, then try again.`), true);
    }, options.ceilingMs);
    timer.unref();

    worker.on("message", (reply: WorkerReply) => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      void worker.terminate();
      if (!reply.ok) {
        reject(new Error(reply.error ?? "The query failed."));
        return;
      }
      resolve(reply.results ?? {});
    });
    worker.on("error", (error: unknown) => {
      stop(error instanceof Error ? error : new Error(String(error)), false);
    });
    worker.on("exit", (code) => {
      stop(new Error(code === 0 ? "The query stopped without returning a result." : `The query worker exited with code ${code}.`), false);
    });
  });

  return {
    result,
    terminate: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      void worker.terminate();
    },
    isStopped: () => stopped,
  };
}
