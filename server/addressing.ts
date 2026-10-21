import type { DatabaseSync } from "node:sqlite";
import type { z } from "zod";
import type { keyValueSchema, writeValueSchema } from "../shared/contracts";
import { bindValue, type BindValue } from "../shared/cell-encoding";
import { hasRowId, primaryKeyColumns, quoteIdentifier } from "./schema";

type KeyValue = z.infer<typeof keyValueSchema>;
type WriteValue = z.infer<typeof writeValueSchema>;

/** The WHERE clause that addresses exactly one row. */
export function addressClause(db: DatabaseSync, object: string, key: readonly KeyValue[]): { sql: string; params: unknown[] } {
  if (hasRowId(db, object)) {
    if (key.length !== 1) throw new Error("This row is addressed by its rowid, which is missing.");
    return { sql: "rowid = ?", params: [bindValue(key[0] ?? null)] };
  }
  const primaryKey = primaryKeyColumns(db, object);
  if (primaryKey.length === 0) {
    throw new Error(`${object} has no primary key, so a single row cannot be addressed.`);
  }
  if (key.length !== primaryKey.length) throw new Error("This row's primary key is incomplete.");
  return {
    sql: primaryKey.map((column) => `${quoteIdentifier(column)} = ?`).join(" and "),
    params: key.map((value) => bindValue(value)),
  };
}

/** A value the user typed, as a SQLite bind parameter. */
export function writeBindValue(value: WriteValue): BindValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (value.kind === "bigint") return BigInt(value.value);
  const binary = Buffer.from(value.base64, "base64");
  return new Uint8Array(binary);
}
