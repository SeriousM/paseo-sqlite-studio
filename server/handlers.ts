import { existsSync, writeFileSync } from "node:fs";
import { readdir, stat as statAsync } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { z } from "zod";
import type { Cell, Filter, jobStartInputSchema, keyValueSchema } from "../shared/contracts";
import { DATABASE_EXTENSIONS } from "../shared/databases";

type JobRequest = z.infer<typeof jobStartInputSchema>;
import { classifySqliteError, readDatabaseInfo, type SqliteEngine } from "./engine";
import type { JobRegistry } from "./jobs";
import { assembleRowQuery, buildConditions, buildCountQuery, buildRowQuery, type RowQuerySpec } from "./rows";
import { runQueriesInWorker } from "./sql-worker";
import {
  describeColumns,
  listForeignKeys,
  listIndexes,
  listObjects,
  objectKind,
  primaryKeyColumns,
  quoteIdentifier,
  rowIdAlias,
} from "./schema";
import type { columnAssignmentSchema } from "../shared/contracts";
import { addressClause } from "./addressing";
import { deleteRowOf, insertRowOf, updateRowOf } from "./mutations";

type KeyValue = z.infer<typeof keyValueSchema>;
type ColumnAssignment = z.infer<typeof columnAssignmentSchema>;

const DEFAULT_DATABASE_EXTENSIONS: readonly string[] = DATABASE_EXTENSIONS;
const MAX_DIRECTORY_ENTRIES = 500;
/** Names inspected before the listing reports itself as truncated. */
const MAX_DIRECTORY_SCAN = 5000;
/** A single grid page may scan this long before it reports a partial result. */
const ROW_BUDGET_MS = 5000;
/** Hard ceiling for a grid page, so a runaway sort cannot spin forever. */
const ROW_CEILING_MS = 20_000;
const MAX_CELL_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_CELL_BLOB_BYTES = 8 * 1024 * 1024;

function readableError(error: unknown): Error {
  const classified = classifySqliteError(error);
  const message = classified.message.replace(/^SQLite error: /i, "");
  return new Error(message);
}

function withDatabase<T>(engine: SqliteEngine, handleId: string, run: (db: DatabaseSync) => T): T {
  const entry = engine.get(handleId);
  try {
    return run(entry.db);
  } catch (error) {
    throw readableError(error);
  }
}

/**
 * Lists a directory for the file browser. Uses directory entries instead of stat-ing
 * every name, because a folder with a hundred thousand files used to make this call
 * take long enough to look hung, and it blocked every other RPC while it ran.
 */
export async function listPath(input: { path: string; extensions?: readonly string[] | null }) {
  const target = resolve(input.path);
  const configured = input.extensions ?? DEFAULT_DATABASE_EXTENSIONS;
  const wanted = new Set(configured.map((value) => value.toLowerCase()));
  const showEveryFile = configured.length === 0;

  const directory = await statAsync(target);
  if (!directory.isDirectory()) throw new Error(`${target} is not a directory.`);

  const dirents = await readdir(target, { withFileTypes: true });
  const candidates: Array<{ name: string; path: string; isDirectory: boolean }> = [];
  let truncated = false;
  let scanned = 0;
  for (const dirent of dirents) {
    if (candidates.length >= MAX_DIRECTORY_ENTRIES || scanned >= MAX_DIRECTORY_SCAN) {
      truncated = true;
      break;
    }
    scanned += 1;
    if (dirent.name.startsWith(".")) continue;
    if (dirent.isDirectory()) {
      candidates.push({ name: dirent.name, path: join(target, dirent.name), isDirectory: true });
      continue;
    }
    if (!dirent.isFile()) continue;
    if (!showEveryFile) {
      const extension = dirent.name.includes(".") ? (dirent.name.split(".").pop() ?? "").toLowerCase() : "";
      if (!wanted.has(extension)) continue;
    }
    candidates.push({ name: dirent.name, path: join(target, dirent.name), isDirectory: false });
  }

  // Only the entries that are actually returned get a stat.
  const settled = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const stats = await statAsync(candidate.path);
        return {
          ...candidate,
          sizeBytes: candidate.isDirectory ? 0 : stats.size,
          modifiedAt: stats.mtimeMs,
        };
      } catch {
        return null;
      }
    }),
  );
  const entries = settled
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });

  const parent = dirname(target);
  return { path: target, parentPath: parent === target ? null : parent, entries, truncated };
}

export async function openPath(engine: SqliteEngine, input: { path: string; mode?: "direct" | "snapshot" | undefined }) {
  const outcome = await engine.open(input.path, input.mode ?? "direct");
  if (!outcome.ok) return { ok: false as const, error: outcome.error };
  const entry = outcome.entry;
  return {
    ok: true as const,
    handleId: entry.handleId,
    path: entry.path,
    snapshotPath: entry.snapshotPath,
    readOnly: true,
    sizeBytes: entry.sizeBytes,
    modifiedAt: entry.modifiedAt,
    warnings: entry.warnings,
    info: readDatabaseInfo(entry.db),
  };
}

export function closeHandle(engine: SqliteEngine, input: { handleId: string }) {
  return { closed: engine.close(input.handleId) };
}

export function readSchemaOf(engine: SqliteEngine, input: { handleId: string }) {
  return withDatabase(engine, input.handleId, (db) => ({
    objects: listObjects(db),
    info: readDatabaseInfo(db),
  }));
}

export function readObjectOf(engine: SqliteEngine, input: { handleId: string; name: string }) {
  return withDatabase(engine, input.handleId, (db) => {
    const kind = objectKind(db, input.name);
    if (!kind) throw new Error(`No such table, view, index, or trigger: ${input.name}`);
    const master = db.prepare("select sql from sqlite_master where name = ?").get(input.name) as
      | { sql: string | null }
      | undefined;
    const isData = kind === "table" || kind === "view" || kind === "virtual-table" || kind === "shadow-table";
    const detail = isData ? describeColumns(db, input.name) : { columns: [], withoutRowId: false, strict: false };
    const editable =
      isData && (rowIdAlias(db, input.name) !== null || primaryKeyColumns(db, input.name).length > 0);
    return {
      kind,
      name: input.name,
      parentName: null,
      sql: master?.sql ?? null,
      withoutRowId: detail.withoutRowId,
      strict: detail.strict,
      editable,
      columns: detail.columns,
      indexes: isData ? listIndexes(db, input.name) : [],
      foreignKeys: isData ? listForeignKeys(db, input.name) : [],
    };
  });
}

/**
 * Reads a page outside the plugin thread. Building the statement needs only pragma
 * lookups, so it stays here; the scan, the sort, and the count run in the worker.
 */
export async function readRowsOf(engine: SqliteEngine, input: RowQuerySpec & { handleId: string }) {
  const { handleId, ...spec } = input;
  const entry = engine.get(handleId);
  const query = buildRowQuery(entry.db, { ...spec, limit: spec.limit + 1 });
  const queries = [
    {
      id: "page",
      sql: query.sql,
      params: query.params,
      limit: null,
      rowColumns: query.displayNames,
      keyColumns: query.identity?.readColumns ?? [],
      cursorColumns: query.cursorColumns,
      budgetMs: ROW_BUDGET_MS,
    },
  ];
  if (spec.countExact === true) {
    const count = buildCountQuery(entry.db, spec);
    queries.push({
      id: "count",
      sql: count.sql,
      params: count.params,
      limit: null,
      rowColumns: ["c"],
      keyColumns: [],
      cursorColumns: [],
      budgetMs: ROW_BUDGET_MS,
    });
  }

  const run = runQueriesInWorker({ path: entry.snapshotPath ?? entry.path, queries, ceilingMs: ROW_CEILING_MS });
  let results;
  try {
    results = await run.result;
  } catch (error) {
    throw readableError(error);
  }
  const page = results.page;
  if (!page) throw new Error("The query returned no result.");
  return assembleRowQuery(query, page, countFromCell(results.count?.rows?.[0]?.[0]), spec.limit);
}

/** A count arrives as an encoded cell so it survives the driver's BigInt mode. */
function countFromCell(cell: unknown): number | null {
  if (typeof cell === "number") return cell;
  if (typeof cell === "object" && cell !== null && "kind" in cell) {
    const tagged = cell as { kind: string; value?: string };
    if (tagged.kind === "bigint" && typeof tagged.value === "string") return Number(tagged.value);
  }
  return null;
}

export function readCellOf(
  engine: SqliteEngine,
  input: { handleId: string; object: string; column: string; key: readonly KeyValue[] },
) {
  return withDatabase(engine, input.handleId, (db) => {
    const detail = describeColumns(db, input.object);
    if (!detail.columns.some((column) => column.name === input.column)) {
      throw new Error(`Unknown column: ${input.column}`);
    }
    const address = addressClause(db, input.object, input.key);
    const sql = `select ${quoteIdentifier(input.column)} as value from ${quoteIdentifier(input.object)} where ${address.sql}`;
    const statement = db.prepare(sql);
    if (typeof statement.setReadBigInts === "function") statement.setReadBigInts(true);
    const row = statement.get(...(address.params as never[])) as { value?: unknown } | undefined;
    if (!row) throw new Error("That row no longer exists.");

    const value = row.value ?? null;
    if (value === null) return { kind: "null" as const, text: null, base64: null, sizeBytes: 0, truncated: false };
    if (value instanceof Uint8Array) {
      const truncated = value.byteLength > MAX_CELL_BLOB_BYTES;
      const bytes = truncated ? value.subarray(0, MAX_CELL_BLOB_BYTES) : value;
      return {
        kind: "blob" as const,
        text: null,
        base64: Buffer.from(bytes).toString("base64"),
        sizeBytes: value.byteLength,
        truncated,
      };
    }
    const text = typeof value === "bigint" ? value.toString() : String(value);
    const truncated = Buffer.byteLength(text, "utf8") > MAX_CELL_TEXT_BYTES;
    return {
      kind: "text" as const,
      text: truncated ? text.slice(0, MAX_CELL_TEXT_BYTES) : text,
      base64: null,
      sizeBytes: Buffer.byteLength(text, "utf8"),
      truncated,
    };
  });
}

export function startJobOf(jobs: JobRegistry, input: JobRequest) {
  return jobs.start(input);
}

export function pollJobOf(jobs: JobRegistry, input: { jobId: string }) {
  return jobs.poll(input.jobId);
}

export function cancelJobOf(jobs: JobRegistry, input: { jobId: string }) {
  return { cancelled: jobs.cancel(input.jobId) };
}

export function setWriting(engine: SqliteEngine, input: { handleId: string; enabled: boolean }) {
  return engine.setWritable(input.handleId, input.enabled);
}

function requireWritable(engine: SqliteEngine, handleId: string) {
  const entry = engine.get(handleId);
  if (entry.readOnly) throw new Error("Editing is off for this database. Turn it on to change rows.");
  return entry;
}

export function insertRowIn(
  engine: SqliteEngine,
  input: { handleId: string; object: string; values: readonly ColumnAssignment[] },
) {
  const entry = requireWritable(engine, input.handleId);
  try {
    return insertRowOf(entry.db, input);
  } catch (error) {
    throw readableError(error);
  }
}

export function updateRowIn(
  engine: SqliteEngine,
  input: {
    handleId: string;
    object: string;
    key: readonly KeyValue[];
    changes: readonly ColumnAssignment[];
    expected?: readonly ColumnAssignment[] | null;
  },
) {
  const entry = requireWritable(engine, input.handleId);
  try {
    return updateRowOf(entry.db, input);
  } catch (error) {
    throw readableError(error);
  }
}

export function deleteRowIn(
  engine: SqliteEngine,
  input: { handleId: string; object: string; key: readonly KeyValue[]; expected?: readonly ColumnAssignment[] | null },
) {
  const entry = requireWritable(engine, input.handleId);
  try {
    return deleteRowOf(entry.db, input);
  } catch (error) {
    throw readableError(error);
  }
}

/**
 * Aggregates for one column over the whole filtered set, not just the loaded page:
 * a total over 200 visible rows would quietly lie about the data.
 */
export async function readStatsOf(
  engine: SqliteEngine,
  input: {
    handleId: string;
    object: string;
    column: string;
    filters?: readonly Filter[] | null;
    search?: string | null;
  },
) {
  const entry = engine.get(input.handleId);
  const detail = describeColumns(entry.db, input.object);
  const column = detail.columns.find((candidate) => candidate.name === input.column);
  if (!column) throw new Error(`Unknown column: ${input.column}`);
  const numeric = column.affinity === "integer" || column.affinity === "real" || column.affinity === "numeric";
  const where = buildConditions(input, detail.columns);
  const quoted = quoteIdentifier(column.name);
  const projection = [
    "count(*) as total_rows",
    `count(${quoted}) as non_null`,
    numeric ? `sum(${quoted}) as sum_value` : "null as sum_value",
    numeric ? `avg(${quoted}) as avg_value` : "null as avg_value",
    `min(${quoted}) as min_value`,
    `max(${quoted}) as max_value`,
  ];
  const sql = [
    `select ${projection.join(", ")} from ${quoteIdentifier(input.object)}`,
    where.conditions.length > 0 ? ` where ${where.conditions.join(" and ")}` : "",
  ].join("");
  const run = runQueriesInWorker({
    path: entry.snapshotPath ?? entry.path,
    queries: [
      {
        id: "stats",
        sql,
        params: where.params,
        limit: null,
        rowColumns: ["total_rows", "non_null", "sum_value", "avg_value", "min_value", "max_value"],
        keyColumns: [],
        cursorColumns: [],
        budgetMs: ROW_BUDGET_MS,
      },
    ],
    ceilingMs: ROW_CEILING_MS,
  });
  let results;
  try {
    results = await run.result;
  } catch (error) {
    throw readableError(error);
  }
  const row: (Cell | undefined)[] | undefined = results.stats?.rows[0];
  if (!row) throw new Error("The statistics query returned no result.");
  const rows = numberFromCell(row[0]);
  const values = numberFromCell(row[1]);
  return {
    column: column.name,
    rows,
    values,
    nulls: Math.max(0, rows - values),
    numeric,
    sum: numeric ? numberFromCell(row[2]) : null,
    average: numeric ? numberFromCell(row[3]) : null,
    min: row[4] ?? null,
    max: row[5] ?? null,
  };
}

function numberFromCell(cell: unknown): number {
  if (typeof cell === "number") return cell;
  if (typeof cell === "object" && cell !== null && "kind" in cell) {
    const tagged = cell as { kind: string; value?: string };
    if (tagged.kind === "bigint" && typeof tagged.value === "string") return Number(tagged.value);
  }
  return 0;
}

/** Writes one binary cell to a file the user picked, on the daemon host. */
export function saveBlobOf(
  engine: SqliteEngine,
  input: {
    handleId: string;
    object: string;
    column: string;
    key: readonly KeyValue[];
    targetPath: string;
    overwrite?: boolean | null;
  },
) {
  const entry = engine.get(input.handleId);
  const detail = describeColumns(entry.db, input.object);
  if (!detail.columns.some((column) => column.name === input.column)) {
    throw new Error(`Unknown column: ${input.column}`);
  }
  const address = addressClause(entry.db, input.object, input.key);
  const statement = entry.db.prepare(
    `select ${quoteIdentifier(input.column)} as value from ${quoteIdentifier(input.object)} where ${address.sql}`,
  );
  const row = statement.get(...(address.params as never[])) as { value?: unknown } | undefined;
  if (!row) throw new Error("That row no longer exists.");
  const value = row.value ?? null;
  if (value === null) throw new Error("This cell is NULL, so there is nothing to save.");
  if (!(value instanceof Uint8Array)) throw new Error("Only binary values can be saved to a file.");
  if (value.byteLength > MAX_CELL_BLOB_BYTES) {
    throw new Error(`This value is ${value.byteLength} bytes, above the ${MAX_CELL_BLOB_BYTES} byte limit.`);
  }
  const target = resolve(input.targetPath);
  if (existsSync(target) && input.overwrite !== true) {
    throw new Error(`${target} already exists. Enable overwrite to replace it.`);
  }
  writeFileSync(target, value);
  return { path: target, bytes: value.byteLength };
}
