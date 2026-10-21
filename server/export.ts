import { createWriteStream, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { z } from "zod";
import type { exportFormatSchema, filterSchema, sortSchema } from "../shared/contracts";
import { isSafeInteger } from "../shared/cell-encoding";
import { describeColumns, quoteIdentifier } from "./schema";
import { buildConditions, buildOrder } from "./rows";

export type ExportFormat = z.infer<typeof exportFormatSchema>;

export interface ExportRequest {
  object: string;
  sql?: string | null | undefined;
  format: ExportFormat;
  targetPath: string;
  overwrite?: boolean | null | undefined;
  columns?: readonly string[] | null | undefined;
  sort?: readonly z.infer<typeof sortSchema>[] | null | undefined;
  filters?: readonly z.infer<typeof filterSchema>[] | null | undefined;
  search?: string | null | undefined;
}

export interface ExportOutcome {
  path: string;
  bytes: number;
  rows: number;
  truncated: boolean;
}

/** Rows written between event-loop yields, so the plugin stays responsive. */
const YIELD_EVERY_ROWS = 2000;
const MAX_EXPORT_ROWS = 5_000_000;

function csvEscape(value: string, delimiter: string): string {
  const needsQuotes = value.includes(delimiter) || value.includes('"') || value.includes("\n") || value.includes("\r");
  return needsQuotes ? `"${value.replace(/"/g, '""')}"` : value;
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function literal(value: unknown, format: ExportFormat): string {
  if (value === null || value === undefined) {
    return format === "csv" || format === "tsv" ? "" : "NULL";
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `x'${Buffer.from(value).toString("hex")}'`;
  if (typeof value === "number") return String(value);
  return String(value);
}

function jsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  // JSON numbers stop being exact past 2^53, so only those become strings.
  if (typeof value === "bigint") return isSafeInteger(value) ? Number(value) : value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  return String(value);
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "bigint" || typeof value === "number") return value.toString();
  if (value instanceof Uint8Array) return `x'${Buffer.from(value).toString("hex")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildSelect(db: DatabaseSync, request: ExportRequest): { sql: string; params: unknown[] } {
  if (request.sql && request.sql.trim().length > 0) return { sql: request.sql, params: [] };
  const detail = describeColumns(db, request.object);
  const available = detail.columns.filter((column) => column.hidden === "normal");
  const wanted =
    request.columns && request.columns.length > 0
      ? available.filter((column) => request.columns?.includes(column.name))
      : available;
  const where = buildConditions(request, detail.columns);
  const order = buildOrder(request, detail.columns);
  const sql = [
    `select ${wanted.map((column) => quoteIdentifier(column.name)).join(", ")} from ${quoteIdentifier(request.object)}`,
    where.conditions.length > 0 ? ` where ${where.conditions.join(" and ")}` : "",
    order.length > 0 ? ` order by ${order.join(", ")}` : "",
  ].join("");
  return { sql, params: where.params };
}

export async function writeExport(
  db: DatabaseSync,
  request: ExportRequest,
  signal: { cancelled: boolean },
): Promise<ExportOutcome> {
  const target = resolve(request.targetPath);
  if (existsSync(target) && request.overwrite !== true) {
    throw new Error(`${target} already exists. Enable overwrite to replace it.`);
  }
  const { sql: select, params } = buildSelect(db, request);
  const statement = db.prepare(select) as StatementSync;
  if (typeof statement.setReadBigInts === "function") statement.setReadBigInts(true);

  const declared =
    typeof statement.columns === "function"
      ? (statement.columns() as Array<{ name: string | null }>).filter((column) => column.name !== null)
      : [];
  let names = declared.map((column) => column.name ?? "?");
  if (names.length === 0) {
    // Fall back to the object's columns when the driver reports none.
    names = describeColumns(db, request.object)
      .columns.filter((column) => column.hidden === "normal")
      .map((column) => column.name);
  }

  const stream = createWriteStream(target, { encoding: "utf8" });
  let streamFailure: Error | null = null;
  stream.on("error", (error: unknown) => {
    streamFailure = error instanceof Error ? error : new Error(String(error));
  });
  const write = async (chunk: string) => {
    if (streamFailure) throw streamFailure;
    if (stream.write(chunk)) return;
    await new Promise<void>((done) => {
      const release = () => {
        stream.off("drain", release);
        stream.off("error", release);
        done();
      };
      stream.once("drain", release);
      stream.once("error", release);
    });
    if (streamFailure) throw streamFailure;
  };

  let rows = 0;
  let bytes = 0;
  let truncated = false;
  const track = async (chunk: string) => {
    bytes += Buffer.byteLength(chunk, "utf8");
    await write(chunk);
  };

  const delimiter = request.format === "tsv" ? "\t" : ",";
  try {
    if (request.format === "csv" || request.format === "tsv") {
      await track(`${names.map((name) => csvEscape(name, delimiter)).join(delimiter)}\r\n`);
    } else if (request.format === "json") {
      await track("[\n");
    } else if (request.format === "markdown") {
      await track(`| ${names.join(" | ")} |\n| ${names.map(() => "---").join(" | ")} |\n`);
    } else if (request.format === "html") {
      await track(
        `<!doctype html>\n<meta charset="utf-8">\n<title>${htmlEscape(request.object)}</title>\n<table>\n<thead><tr>${names
          .map((name) => `<th>${htmlEscape(name)}</th>`)
          .join("")}</tr></thead>\n<tbody>\n`,
      );
    } else if (request.format === "sql") {
      await track(`-- ${request.object} exported from ${select}\n`);
    }

    for (const row of statement.iterate(...(params as never[])) as IterableIterator<Record<string, unknown>>) {
      if (signal.cancelled) throw new Error("Export cancelled.");
      if (names.length === 0) names = Object.keys(row);
      const values = names.map((name) => row[name]);
      switch (request.format) {
        case "csv":
        case "tsv":
          await track(`${values.map((value) => csvEscape(literal(value, request.format), delimiter)).join(delimiter)}\r\n`);
          break;
        case "jsonl":
          await track(`${JSON.stringify(Object.fromEntries(names.map((name, index) => [name, jsonValue(values[index])])))}\n`);
          break;
        case "json":
          await track(`${rows === 0 ? "" : ",\n"}${JSON.stringify(Object.fromEntries(names.map((name, index) => [name, jsonValue(values[index])])))}`);
          break;
        case "markdown":
          await track(`| ${values.map((value) => literal(value, request.format).replace(/\|/g, "\\|").replace(/\r?\n/g, " ")).join(" | ")} |\n`);
          break;
        case "html":
          await track(`<tr>${values.map((value) => `<td>${htmlEscape(literal(value, request.format))}</td>`).join("")}</tr>\n`);
          break;
        case "sql":
          await track(
            `insert into ${quoteIdentifier(request.object)} (${names.map(quoteIdentifier).join(", ")}) values (${values
              .map(sqlLiteral)
              .join(", ")});\n`,
          );
          break;
      }
      rows += 1;
      if (rows >= MAX_EXPORT_ROWS) {
        truncated = true;
        break;
      }
      if (rows % YIELD_EVERY_ROWS === 0) {
        // Let other RPCs run while a large export streams out.
        await new Promise<void>((done) => setImmediate(done));
      }
    }

    if (request.format === "json") await track("\n]\n");
    if (request.format === "html") await track("</tbody>\n</table>\n");
  } finally {
    await new Promise<void>((done) => stream.end(done));
    if (streamFailure) throw streamFailure;
  }

  return { path: target, bytes, rows, truncated };
}
