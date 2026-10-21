import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { z } from "zod";
import type { jobStartInputSchema } from "../shared/contracts";

type JobRequest = z.infer<typeof jobStartInputSchema>;
import type { keyValueSchema } from "../shared/contracts";
import { classifySqliteError, readDatabaseInfo, type SqliteEngine } from "./engine";
import type { JobRegistry } from "./jobs";
import { runRowQuery, type RowQuerySpec } from "./rows";
import {
  describeColumns,
  hasRowId,
  listForeignKeys,
  listIndexes,
  listObjects,
  objectKind,
  primaryKeyColumns,
  quoteIdentifier,
} from "./schema";
import type { columnAssignmentSchema } from "../shared/contracts";
import { addressClause } from "./addressing";
import { deleteRowOf, insertRowOf, updateRowOf } from "./mutations";

type KeyValue = z.infer<typeof keyValueSchema>;
type ColumnAssignment = z.infer<typeof columnAssignmentSchema>;

const DEFAULT_DATABASE_EXTENSIONS = ["db", "sqlite", "sqlite3", "db3", "s3db", "gpkg", "sqlite2"];
const MAX_DIRECTORY_ENTRIES = 1000;
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

export function listPath(input: { path: string; extensions?: readonly string[] | null }) {
  const target = resolve(input.path);
  const wanted = new Set((input.extensions ?? DEFAULT_DATABASE_EXTENSIONS).map((value) => value.toLowerCase()));
  const entries: Array<{ name: string; path: string; isDirectory: boolean; sizeBytes: number; modifiedAt: number }> = [];
  let truncated = false;
  const directory = statSync(target);
  if (!directory.isDirectory()) throw new Error(`${target} is not a directory.`);

  const names = readdirSync(target).sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    if (entries.length >= MAX_DIRECTORY_ENTRIES) {
      truncated = true;
      break;
    }
    if (name.startsWith(".")) continue;
    const entryPath = join(target, name);
    let stats;
    try {
      stats = statSync(entryPath);
    } catch {
      continue;
    }
    const isDirectory = stats.isDirectory();
    if (!isDirectory) {
      const extension = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
      if (!wanted.has(extension)) continue;
    }
    entries.push({
      name,
      path: entryPath,
      isDirectory,
      sizeBytes: isDirectory ? 0 : stats.size,
      modifiedAt: stats.mtimeMs,
    });
  }
  const parent = dirname(target);
  return { path: target, parentPath: parent === target ? null : parent, entries, truncated };
}

export function openPath(engine: SqliteEngine, input: { path: string; mode?: "direct" | "snapshot" | undefined }) {
  const outcome = engine.open(input.path, input.mode ?? "direct");
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
    return {
      kind,
      name: input.name,
      parentName: null,
      sql: master?.sql ?? null,
      withoutRowId: detail.withoutRowId,
      strict: detail.strict,
      columns: detail.columns,
      indexes: isData ? listIndexes(db, input.name) : [],
      foreignKeys: isData ? listForeignKeys(db, input.name) : [],
    };
  });
}

export function readRowsOf(engine: SqliteEngine, input: RowQuerySpec & { handleId: string }) {
  const { handleId, ...spec } = input;
  return withDatabase(engine, handleId, (db) => runRowQuery(db, spec));
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
  input: { handleId: string; object: string; key: readonly KeyValue[]; changes: readonly ColumnAssignment[] },
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
  input: { handleId: string; object: string; key: readonly KeyValue[] },
) {
  const entry = requireWritable(engine, input.handleId);
  try {
    return deleteRowOf(entry.db, input);
  } catch (error) {
    throw readableError(error);
  }
}
