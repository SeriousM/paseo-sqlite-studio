import type { DatabaseSync } from "node:sqlite";
import type { z } from "zod";
import type { columnSchema, indexSchema, objectSummarySchema, foreignKeySchema, objectKindSchema } from "../shared/contracts";

type Column = z.infer<typeof columnSchema>;
type IndexInfo = z.infer<typeof indexSchema>;
type ForeignKey = z.infer<typeof foreignKeySchema>;
type ObjectSummary = z.infer<typeof objectSummarySchema>;
export type ObjectKind = z.infer<typeof objectKindSchema>;

interface TableListRow {
  name: string;
  type: string;
  ncol: number;
  wr: number;
  strict: number;
}

export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** SQLite's affinity rules, applied to a declared type. */
export function affinityOf(declaredType: string): Column["affinity"] {
  const upper = declaredType.toUpperCase();
  if (upper.includes("INT")) return "integer";
  if (upper.includes("CHAR") || upper.includes("CLOB") || upper.includes("TEXT")) return "text";
  if (upper.includes("BLOB") || upper.length === 0) return "blob";
  if (upper.includes("REAL") || upper.includes("FLOA") || upper.includes("DOUB")) return "real";
  return "numeric";
}

function readTableList(db: DatabaseSync): Map<string, TableListRow> {
  const rows = db.prepare("pragma table_list").all() as unknown as TableListRow[];
  const map = new Map<string, TableListRow>();
  for (const row of rows) map.set(row.name, row);
  return map;
}

function kindOf(masterType: string, tableList: TableListRow | undefined): ObjectKind {
  if (masterType === "view") return "view";
  if (masterType === "index") return "index";
  if (masterType === "trigger") return "trigger";
  if (tableList?.type === "virtual") return "virtual-table";
  if (tableList?.type === "shadow") return "shadow-table";
  return "table";
}

/**
 * Shadow tables are named `<virtual-table>_<suffix>`. Finding the longest
 * virtual-table prefix names the owner so the tree can nest them.
 */
function shadowParent(name: string, virtualTables: readonly string[]): string | null {
  let best: string | null = null;
  for (const candidate of virtualTables) {
    if (!name.startsWith(`${candidate}_`)) continue;
    if (!best || candidate.length > best.length) best = candidate;
  }
  return best;
}

export function listObjects(db: DatabaseSync): ObjectSummary[] {
  const tableList = readTableList(db);
  const master = db
    .prepare("select type, name, tbl_name, sql from sqlite_master order by type, name")
    .all() as unknown as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  const virtualTables = master
    .filter((row) => row.type === "table" && tableList.get(row.name)?.type === "virtual")
    .map((row) => row.name);

  const objects: ObjectSummary[] = [];
  for (const row of master) {
    if (row.name.startsWith("sqlite_") && row.name !== "sqlite_sequence") continue;
    const kind = kindOf(row.type, tableList.get(row.name));
    objects.push({
      kind,
      name: row.name,
      parentName: kind === "shadow-table" ? shadowParent(row.name, virtualTables) : kind === "index" || kind === "trigger" ? row.tbl_name : null,
      sql: row.sql,
    });
  }
  return objects;
}

export interface ColumnDetail {
  columns: Column[];
  withoutRowId: boolean;
  strict: boolean;
}

export function describeColumns(db: DatabaseSync, name: string): ColumnDetail {
  const tableList = readTableList(db);
  const info = tableList.get(name);
  const rows = db.prepare(`pragma table_xinfo(${quoteIdentifier(name)})`).all() as unknown as Array<{
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
    hidden: number;
  }>;

  const uniqueSingleColumns = new Set<string>();
  const indexRows = db.prepare(`pragma index_list(${quoteIdentifier(name)})`).all() as unknown as Array<{
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }>;
  for (const index of indexRows) {
    if (!index.unique || index.partial) continue;
    const indexColumns = (
      db.prepare(`pragma index_info(${quoteIdentifier(index.name)})`).all() as unknown as Array<{ name: string | null }>
    ).filter((column) => column.name !== null);
    if (indexColumns.length === 1 && indexColumns[0]?.name) uniqueSingleColumns.add(indexColumns[0].name);
  }

  const hiddenKinds: Record<number, Column["hidden"]> = {
    0: "normal",
    1: "virtual",
    2: "generated-dynamic",
    3: "generated-stored",
  };

  const primaryKeyColumns = rows.filter((row) => row.pk > 0);
  const columns: Column[] = rows.map((row) => ({
    name: row.name,
    declaredType: row.type,
    affinity: affinityOf(row.type),
    notNull: row.notnull === 1,
    defaultValue: row.dflt_value,
    primaryKeyPosition: row.pk,
    hidden: hiddenKinds[row.hidden] ?? "normal",
    // A single-column primary key is unique whether or not the table has a rowid.
    unique: uniqueSingleColumns.has(row.name) || (primaryKeyColumns.length === 1 && row.pk > 0),
  }));

  return { columns, withoutRowId: info?.wr === 1, strict: info?.strict === 1 };
}

export function listIndexes(db: DatabaseSync, name: string): IndexInfo[] {
  const rows = db.prepare(`pragma index_list(${quoteIdentifier(name)})`).all() as unknown as Array<{
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }>;
  const origins: Record<string, IndexInfo["origin"]> = {
    c: "create-index",
    u: "unique-constraint",
    pk: "primary-key",
  };
  return rows.map((row) => {
    const columns = db.prepare(`pragma index_info(${quoteIdentifier(row.name)})`).all() as unknown as Array<{
      name: string | null;
    }>;
    const ddl = db.prepare("select sql from sqlite_master where name = ?").get(row.name) as
      | { sql: string | null }
      | undefined;
    return {
      name: row.name,
      unique: row.unique === 1,
      partial: row.partial === 1,
      origin: origins[row.origin] ?? "create-index",
      columns: columns.map((column) => column.name ?? "<expression>"),
      sql: ddl?.sql ?? null,
    };
  });
}

export function listForeignKeys(db: DatabaseSync, name: string): ForeignKey[] {
  const rows = db.prepare(`pragma foreign_key_list(${quoteIdentifier(name)})`).all() as unknown as Array<{
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string | null;
    on_update: string;
    on_delete: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    fromColumn: row.from,
    toTable: row.table,
    toColumn: row.to,
    onUpdate: row.on_update,
    onDelete: row.on_delete,
  }));
}

export function countRows(db: DatabaseSync, name: string): number {
  const row = db.prepare(`select count(*) as c from ${quoteIdentifier(name)}`).get() as { c: number | bigint };
  return typeof row.c === "bigint" ? Number(row.c) : row.c;
}

/** True when rows of `name` can be addressed by `rowid`. */
export function hasRowId(db: DatabaseSync, name: string): boolean {
  const info = readTableList(db).get(name);
  if (!info) return false;
  return info.type === "table" && info.wr === 0;
}

export function primaryKeyColumns(db: DatabaseSync, name: string): string[] {
  return describeColumns(db, name)
    .columns.filter((column) => column.primaryKeyPosition > 0)
    .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition)
    .map((column) => column.name);
}

export function objectKind(db: DatabaseSync, name: string): ObjectKind | null {
  const master = db.prepare("select type from sqlite_master where name = ?").get(name) as
    | { type: string }
    | undefined;
  if (!master) return null;
  return kindOf(master.type, readTableList(db).get(name));
}
