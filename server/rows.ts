import type { DatabaseSync } from "node:sqlite";
import type { z } from "zod";
import type { Cell, columnSchema, filterSchema, rowQueryResultSchema, sortSchema, keyValueSchema } from "../shared/contracts";
import { describeColumns, hasRowId, primaryKeyColumns, quoteIdentifier } from "./schema";
import { bindValue } from "../shared/cell-encoding";
import type { WorkerQueryResult } from "./sql-worker";

type WorkerRows = Pick<WorkerQueryResult, "rows" | "keys" | "elapsedMs">;

type RowQueryResult = z.infer<typeof rowQueryResultSchema>;
type Column = z.infer<typeof columnSchema>;
type Filter = z.infer<typeof filterSchema>;
type Sort = z.infer<typeof sortSchema>;
type KeyValue = z.infer<typeof keyValueSchema>;

export interface RowQuerySpec {
  object: string;
  columns?: readonly string[] | null;
  sort?: readonly Sort[] | null;
  filters?: readonly Filter[] | null;
  search?: string | null;
  limit: number;
  offset?: number | null;
  cursor?: readonly KeyValue[] | null;
  countExact?: boolean | null;
}

export interface BuiltQuery {
  sql: string;
  params: unknown[];
  identity: Identity | null;
  displayNames: string[];
  columns: Column[];
}

interface Identity {
  /** Columns the ORDER BY and keyset comparison use. */
  orderColumns: string[];
  /** Keys to read the key values out of a result row. */
  readColumns: string[];
  usesRowId: boolean;
}

const MAX_SEARCH_COLUMNS = 40;
/**
 * `select rowid` on an INTEGER PRIMARY KEY table comes back named after that
 * column, so the row id needs its own alias to stay readable.
 */
const ROWID_ALIAS = "__paseo_rowid__";

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function filterClause(filter: Filter, quotedColumn: string): { sql: string; params: unknown[] } {
  const asText = `CAST(${quotedColumn} AS TEXT)`;
  const value = filter.value ?? "";
  switch (filter.operator) {
    case "eq":
      return { sql: `${quotedColumn} = ?`, params: [value] };
    case "ne":
      return { sql: `${quotedColumn} IS NOT ?`, params: [value] };
    case "lt":
      return { sql: `${quotedColumn} < ?`, params: [value] };
    case "lte":
      return { sql: `${quotedColumn} <= ?`, params: [value] };
    case "gt":
      return { sql: `${quotedColumn} > ?`, params: [value] };
    case "gte":
      return { sql: `${quotedColumn} >= ?`, params: [value] };
    case "contains":
      return { sql: `${asText} LIKE ? ESCAPE '\\'`, params: [`%${escapeLike(value)}%`] };
    case "notContains":
      return { sql: `${asText} NOT LIKE ? ESCAPE '\\'`, params: [`%${escapeLike(value)}%`] };
    case "startsWith":
      return { sql: `${asText} LIKE ? ESCAPE '\\'`, params: [`${escapeLike(value)}%`] };
    case "endsWith":
      return { sql: `${asText} LIKE ? ESCAPE '\\'`, params: [`%${escapeLike(value)}`] };
    case "isNull":
      return { sql: `${quotedColumn} IS NULL`, params: [] };
    case "isNotNull":
      return { sql: `${quotedColumn} IS NOT NULL`, params: [] };
    case "isEmpty":
      return { sql: `${asText} = ''`, params: [] };
    case "isNotEmpty":
      return { sql: `${asText} <> ''`, params: [] };
  }
}

function resolveIdentity(db: DatabaseSync, object: string): Identity | null {
  if (hasRowId(db, object)) return { orderColumns: ["rowid"], readColumns: [ROWID_ALIAS], usesRowId: true };
  const primaryKey = primaryKeyColumns(db, object);
  return primaryKey.length > 0
    ? { orderColumns: primaryKey, readColumns: primaryKey, usesRowId: false }
    : null;
}

/** Key-ordered paging only applies when the page order already follows the identity. */
function keysetClause(identity: Identity, sort: readonly Sort[], cursor: readonly KeyValue[]): string | null {
  if (cursor.length !== identity.orderColumns.length) return null;
  const orderedByIdentity =
    sort.length === 0 ||
    (sort.length === identity.orderColumns.length &&
      sort.every(
        (entry, index) => entry.column === identity.orderColumns[index] && entry.direction === "asc",
      ));
  if (!orderedByIdentity) return null;
  if (identity.orderColumns.length === 1) {
    return `${quoteIdentifier(identity.orderColumns[0] ?? "rowid")} > ?`;
  }
  const left = identity.orderColumns.map(quoteIdentifier).join(", ");
  const right = identity.orderColumns.map(() => "?").join(", ");
  return `(${left}) > (${right})`;
}

export function buildConditions(spec: Pick<RowQuerySpec, "filters" | "search">, columns: readonly Column[]): { conditions: string[]; params: unknown[] } {
  const available = new Set(columns.map((column) => column.name));
  const conditions: string[] = [];
  const params: unknown[] = [];

  for (const filter of spec.filters ?? []) {
    if (!available.has(filter.column)) throw new Error(`Unknown column: ${filter.column}`);
    const clause = filterClause(filter, quoteIdentifier(filter.column));
    conditions.push(clause.sql);
    params.push(...clause.params);
  }

  const search = spec.search?.trim();
  if (search && search.length > 0) {
    const searchable = columns
      .filter((column) => column.hidden === "normal")
      .slice(0, MAX_SEARCH_COLUMNS)
      .map((column) => `CAST(${quoteIdentifier(column.name)} AS TEXT) LIKE ? ESCAPE '\\'`);
    if (searchable.length > 0) {
      conditions.push(`(${searchable.join(" or ")})`);
      for (const _column of searchable) params.push(`%${escapeLike(search)}%`);
    }
  }

  return { conditions, params };
}

/** ORDER BY clauses for a request, using only columns that exist. */
export function buildOrder(
  spec: Pick<RowQuerySpec, "sort">,
  columns: readonly Column[],
  identity?: readonly string[],
): string[] {
  const order: string[] = [];
  for (const entry of spec.sort ?? []) {
    if (!columns.some((column) => column.name === entry.column)) continue;
    order.push(`${quoteIdentifier(entry.column)} ${entry.direction}`);
  }
  for (const column of identity ?? []) {
    if ((spec.sort ?? []).some((entry) => entry.column === column)) continue;
    order.push(`${quoteIdentifier(column)} asc`);
  }
  return order;
}

export function buildRowQuery(db: DatabaseSync, spec: RowQuerySpec): BuiltQuery {
  const detail = describeColumns(db, spec.object);
  const identity = resolveIdentity(db, spec.object);
  const { conditions, params } = buildConditions(spec, detail.columns);

  const cursor = spec.cursor ?? null;
  const sort = (spec.sort ?? []).filter((entry) => detail.columns.some((column) => column.name === entry.column));
  const keyset = identity && cursor ? keysetClause(identity, sort, cursor) : null;
  if (keyset) {
    conditions.push(keyset);
    for (const value of cursor ?? []) params.push(bindValue(value));
  }

  const requested =
    spec.columns && spec.columns.length > 0
      ? spec.columns.filter((name) => detail.columns.some((column) => column.name === name))
      : null;
  const allVisible = detail.columns.filter((column) => column.hidden === "normal").map((column) => column.name);
  const displayNames = requested ?? allVisible;

  const selection = [...displayNames];
  for (const column of identity?.readColumns ?? []) {
    if (column !== ROWID_ALIAS && !selection.includes(column)) selection.push(column);
  }
  const projection = selection.map(quoteIdentifier);
  if (identity?.usesRowId) projection.unshift(`rowid as ${quoteIdentifier(ROWID_ALIAS)}`);

  // An explicit sort wins; the identity only breaks ties so paging stays stable.
  const orderBy = buildOrder({ sort }, detail.columns, identity?.orderColumns ?? []);

  let sql = `select ${projection.length > 0 ? projection.join(", ") : "*"} from ${quoteIdentifier(spec.object)}`;
  if (conditions.length > 0) sql += ` where ${conditions.join(" and ")}`;
  if (orderBy.length > 0) sql += ` order by ${orderBy.join(", ")}`;
  sql += ` limit ${spec.limit}`;
  if (!keyset && spec.offset && spec.offset > 0) sql += ` offset ${Math.floor(spec.offset)}`;

  return { sql, params, identity, displayNames, columns: detail.columns };
}

/** The count runs in the worker too, because counting a large table is a full scan. */
export function buildCountQuery(db: DatabaseSync, spec: RowQuerySpec): { sql: string; params: unknown[] } {
  const detail = describeColumns(db, spec.object);
  const { conditions, params } = buildConditions(spec, detail.columns);
  let sql = `select count(*) as c from ${quoteIdentifier(spec.object)}`;
  if (conditions.length > 0) sql += ` where ${conditions.join(" and ")}`;
  return { sql, params };
}

/** Turns what the worker returned into the shape the client contract promises. */
export function assembleRowQuery(
  query: BuiltQuery,
  page: WorkerRows,
  rowCount: number | null,
  limit: number,
): RowQueryResult {
  const hasMore = page.rows.length > limit;
  const rows = hasMore ? page.rows.slice(0, limit) : page.rows;
  const keys = hasMore ? page.keys.slice(0, limit) : page.keys;
  const displayColumns = query.columns.filter((column) => query.displayNames.includes(column.name));
  const lastKey = keys.at(-1);
  return {
    columns: displayColumns.map((column) => ({
      name: column.name,
      declaredType: column.declaredType,
      affinity: column.affinity,
    })),
    rows,
    keys,
    hasMore,
    rowCount,
    nextCursor: hasMore && query.identity && lastKey ? lastKey : null,
    elapsedMs: Math.max(0, Math.round(page.elapsedMs)),
    sql: query.sql,
  };
}
