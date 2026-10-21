import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Contracts shared by the daemon-side engine and the client surfaces.
 *
 * Naming convention: a `Cell` is one table cell as it travels over the RPC
 * boundary. Large values are clipped to a preview and fetched in full through
 * `sqlite.cell`, because a single RPC payload is not a place for megabytes.
 */

export const cellSchema = z.union([
  z.null(),
  z.number(),
  z.string(),
  z.object({ kind: z.literal("bigint"), value: z.string() }),
  z.object({ kind: z.literal("blob"), size: z.number(), previewHex: z.string() }),
  z.object({ kind: z.literal("longtext"), size: z.number(), preview: z.string() }),
]);

export type Cell = z.infer<typeof cellSchema>;

/**
 * Row identity travels in its own shape: a clipped preview cannot address a row,
 * so keys carry full values (blobs included) while cells stay preview-sized.
 */
export const keyValueSchema = z.union([
  z.null(),
  z.number(),
  z.string(),
  z.object({ kind: z.literal("bigint"), value: z.string() }),
  z.object({ kind: z.literal("blob"), base64: z.string() }),
]);

export type KeyValue = z.infer<typeof keyValueSchema>;

export const columnAffinitySchema = z.enum(["integer", "real", "text", "blob", "numeric"]);

export const columnSchema = z.object({
  name: z.string(),
  declaredType: z.string(),
  affinity: columnAffinitySchema,
  notNull: z.boolean(),
  defaultValue: z.string().nullable(),
  primaryKeyPosition: z.number(),
  hidden: z.enum(["normal", "virtual", "generated-dynamic", "generated-stored"]),
  unique: z.boolean(),
});

export const foreignKeySchema = z.object({
  id: z.number(),
  fromColumn: z.string(),
  toTable: z.string(),
  toColumn: z.string().nullable(),
  onUpdate: z.string(),
  onDelete: z.string(),
});

export const indexSchema = z.object({
  name: z.string(),
  unique: z.boolean(),
  partial: z.boolean(),
  origin: z.enum(["create-index", "unique-constraint", "primary-key"]),
  columns: z.array(z.string()),
  sql: z.string().nullable(),
});

export const objectKindSchema = z.enum(["table", "view", "virtual-table", "shadow-table", "index", "trigger"]);

export const databaseInfoSchema = z.object({
  sqliteVersion: z.string(),
  journalMode: z.string(),
  pageSize: z.number(),
  pageCount: z.number(),
  freelistCount: z.number(),
  encoding: z.string(),
  userVersion: z.number(),
  applicationId: z.number(),
  schemaVersion: z.number(),
  autoVacuum: z.number(),
});

export const objectSummarySchema = z.object({
  kind: objectKindSchema,
  name: z.string(),
  /** For shadow tables and indexes: the object they belong to. */
  parentName: z.string().nullable(),
  sql: z.string().nullable(),
});

export const sqliteOpenErrorSchema = z.object({
  code: z.enum(["locked", "not-a-database", "not-found", "permission", "unsupported", "unknown"]),
  message: z.string(),
  /** True when copying the file to a snapshot can still open it. */
  canSnapshot: z.boolean(),
});

export const sqliteOpenResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    handleId: z.string(),
    /** Absolute path on the daemon host that this handle reads. */
    path: z.string(),
    snapshotPath: z.string().nullable(),
    readOnly: z.boolean(),
    sizeBytes: z.number(),
    modifiedAt: z.number(),
    warnings: z.array(z.string()),
    info: databaseInfoSchema,
  }),
  z.object({ ok: z.literal(false), error: sqliteOpenErrorSchema }),
]);

export const sortSchema = z.object({
  column: z.string(),
  direction: z.enum(["asc", "desc"]),
});

export const filterOperatorSchema = z.enum([
  "eq",
  "ne",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "isNull",
  "isNotNull",
  "isEmpty",
  "isNotEmpty",
]);

export const filterSchema = z.object({
  column: z.string(),
  operator: filterOperatorSchema,
  value: z.string().optional(),
});

export type Filter = z.infer<typeof filterSchema>;
export type Sort = z.infer<typeof sortSchema>;

export const rowsInputSchema = z.object({
  handleId: z.string(),
  object: z.string(),
  columns: z.array(z.string()).nullish(),
  sort: z.array(sortSchema).nullish(),
  filters: z.array(filterSchema).nullish(),
  /** Case-insensitive substring match across the object's columns. */
  search: z.string().nullish(),
  limit: z.number().int().min(1).max(1000),
  offset: z.number().int().min(0).nullish(),
  /** Identity of the last row of the previous page, for key-ordered paging. */
  cursor: z.array(keyValueSchema).nullish(),
  /** Runs `count(*)` for the same filters. O(n); the client asks for it on demand. */
  countExact: z.boolean().nullish(),
});

export const rowQueryResultSchema = z.object({
  columns: z.array(z.object({ name: z.string(), declaredType: z.string(), affinity: columnAffinitySchema })),
  rows: z.array(z.array(cellSchema)),
  /** Identity of each row: `[rowid]`, or the primary-key values for WITHOUT ROWID tables. */
  keys: z.array(z.array(keyValueSchema)),
  hasMore: z.boolean(),
  rowCount: z.number().nullable(),
  /** Pass back as `cursor` to fetch the page after this one. */
  nextCursor: z.array(keyValueSchema).nullable(),
  elapsedMs: z.number(),
  /** The statement the engine ran, for transparency and copy-paste. */
  sql: z.string(),
});

export const listDirectory = defineRpc({
  name: "sqlite.list",
  input: z.object({
    path: z.string().min(1),
    /** Lowercase extensions without a dot. Empty lists directories plus every database file. */
    extensions: z.array(z.string()).nullish(),
  }),
  output: z.object({
    path: z.string(),
    parentPath: z.string().nullable(),
    entries: z.array(
      z.object({
        name: z.string(),
        path: z.string(),
        isDirectory: z.boolean(),
        sizeBytes: z.number(),
        modifiedAt: z.number(),
      }),
    ),
    truncated: z.boolean(),
  }),
});

export const openDatabase = defineRpc({
  name: "sqlite.open",
  input: z.object({
    path: z.string().min(1),
    /** `snapshot` copies the file before opening; use it for databases another process locks. */
    mode: z.enum(["direct", "snapshot"]).optional(),
  }),
  output: sqliteOpenResultSchema,
});

export const closeDatabase = defineRpc({
  name: "sqlite.close",
  input: z.object({ handleId: z.string() }),
  output: z.object({ closed: z.boolean() }),
});

export const readSchema = defineRpc({
  name: "sqlite.schema",
  input: z.object({ handleId: z.string() }),
  output: z.object({
    objects: z.array(objectSummarySchema),
    info: databaseInfoSchema,
  }),
});

export const readObject = defineRpc({
  name: "sqlite.object",
  input: z.object({ handleId: z.string(), name: z.string() }),
  output: z.object({
    kind: objectKindSchema,
    name: z.string(),
    parentName: z.string().nullable(),
    sql: z.string().nullable(),
    withoutRowId: z.boolean(),
    strict: z.boolean(),
    columns: z.array(columnSchema),
    indexes: z.array(indexSchema),
    foreignKeys: z.array(foreignKeySchema),
  }),
});

export const readRows = defineRpc({
  name: "sqlite.rows",
  input: rowsInputSchema,
  output: rowQueryResultSchema,
});

export const readCell = defineRpc({
  name: "sqlite.cell",
  input: z.object({
    handleId: z.string(),
    object: z.string(),
    column: z.string(),
    key: z.array(keyValueSchema),
  }),
  output: z.object({
    kind: z.enum(["null", "text", "blob"]),
    text: z.string().nullable(),
    base64: z.string().nullable(),
    sizeBytes: z.number(),
    truncated: z.boolean(),
  }),
});

export const runQuery = defineRpc({
  name: "sqlite.query",
  input: z.object({
    handleId: z.string(),
    sql: z.string().min(1).max(100_000),
    limit: z.number().int().min(1).max(1000).optional(),
  }),
  output: rowQueryResultSchema.extend({
    /** `false` for non-SELECT statements. */
    returnedRows: z.boolean(),
    changes: z.number().nullable(),
  }),
});
