import { pathToFileURL } from "node:url";
import type { z } from "zod";
import type { Cell } from "../shared/contracts";
import type { searchSqliteObjects } from "../shared/attachment";
import type { RpcOutput } from "@getpaseo/plugin";
import { describeColumns, listForeignKeys, listIndexes, listObjects } from "./schema";
import { readRowsOf } from "./handlers";
import type { SqliteEngine } from "./engine";

type AttachmentItem = RpcOutput<typeof searchSqliteObjects>["items"][number];

/** Objects offered per search, and databases scanned per search. */
const MAX_ITEMS = 8;
const MAX_DATABASES = 6;
const SAMPLE_ROWS = 3;
const MAX_TEXT_CHARS = 4000;

function markdownTable(columns: readonly string[], rows: readonly (readonly string[])[]): string {
  const header = `| ${columns.join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map((cell) => cell.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

async function describeObject(engine: SqliteEngine, handleId: string, name: string): Promise<string | null> {
  const entry = engine.get(handleId);
  const db = entry.db;
  const kind = listObjects(db).find((object) => object.name === name);
  if (!kind) return null;

  const detail = describeColumns(db, name);
  const columns = detail.columns.filter((column) => column.hidden === "normal");
  const indexes = listIndexes(db, name);
  const foreignKeys = listForeignKeys(db, name);

  const lines: string[] = [];
  lines.push(`### ${name} (${kind.kind})`);
  if (kind.sql) lines.push("", "```sql", kind.sql.trim(), "```");
  lines.push(
    "",
    "Columns:",
    "",
    markdownTable(
      ["column", "type", "nullable", "key"],
      columns.map((column) => [
        column.name,
        column.declaredType.length > 0 ? column.declaredType : column.affinity,
        column.notNull ? "NOT NULL" : "nullable",
        [
          column.primaryKeyPosition > 0 ? `pk${column.primaryKeyPosition}` : "",
          column.unique ? "unique" : "",
          column.defaultValue === null ? "" : `default ${column.defaultValue}`,
        ]
          .filter((part) => part.length > 0)
          .join(", "),
      ]),
    ),
  );
  if (indexes.length > 0) {
    lines.push("", "Indexes:", ...indexes.map((index) => `- ${index.name} (${index.columns.join(", ")})${index.unique ? " unique" : ""}${index.partial ? " partial" : ""}`));
  }
  if (foreignKeys.length > 0) {
    lines.push(
      "",
      "Foreign keys:",
      ...foreignKeys.map(
        (key) => `- ${key.fromColumn} -> ${key.toTable}.${key.toColumn ?? "rowid"} (on update ${key.onUpdate}, on delete ${key.onDelete})`,
      ),
    );
  }

  if (columns.length > 0) {
    try {
      const sample = await readRowsOf(engine, {
        handleId,
        object: name,
        limit: SAMPLE_ROWS,
        columns: columns.map((column: { name: string }) => column.name),
      });
      if (sample.rows.length > 0) {
        lines.push(
          "",
          `Sample rows (${sample.rows.length} of the first rows):`,
          "",
          markdownTable(
            sample.columns.map((column) => column.name),
            sample.rows.map((row) =>
              row.map((cell) => {
                if (cell === null) return "NULL";
                if (typeof cell === "string" || typeof cell === "number") return String(cell);
                if (cell.kind === "bigint") return cell.value;
                if (cell.kind === "longtext") return `${cell.preview}… (${cell.size} chars)`;
                return `BLOB (${cell.size} bytes)`;
              }),
            ),
          ),
        );
      }
    } catch {
      // A sample is a bonus; a table that cannot be sampled still describes itself.
    }
  }

  const text = lines.join("\n");
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n…` : text;
}

export async function searchAttachments(
  engine: SqliteEngine,
  recentPaths: readonly string[],
  query: string,
): Promise<{ items: AttachmentItem[] }> {
  const needle = query.trim().toLowerCase();
  const items: AttachmentItem[] = [];
  const opened: string[] = [];

  try {
    for (const path of recentPaths.slice(0, MAX_DATABASES)) {
      const outcome = await engine.open(path);
      if (!outcome.ok) continue;
      const handleId = outcome.entry.handleId;
      opened.push(handleId);
      // Prompt context wants data: indexes and triggers describe themselves poorly.
      const objects = listObjects(outcome.entry.db).filter(
        (object) => object.kind === "table" || object.kind === "view" || object.kind === "virtual-table",
      );
      const matches = objects.filter(
        (object) => needle.length === 0 || object.name.toLowerCase().includes(needle),
      );
      for (const match of matches.slice(0, MAX_ITEMS - items.length)) {
        const text = await describeObject(engine, handleId, match.name);
        if (!text) continue;
        const fileName = path.split(/[\\/]/).pop() ?? path;
        items.push({
          id: `${path}#${match.name}`,
          identifier: `${fileName} › ${match.name}`,
          title: match.name,
          subtitle: `${match.kind} in ${fileName}`,
          url: pathToFileURL(path).toString(),
          text,
          resourceType: "sqlite-object",
        });
        if (items.length >= MAX_ITEMS) break;
      }
      if (items.length >= MAX_ITEMS) break;
    }
  } finally {
    for (const handleId of opened) engine.close(handleId);
  }

  return { items };
}
