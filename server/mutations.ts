import type { DatabaseSync } from "node:sqlite";
import type { z } from "zod";
import type { columnAssignmentSchema, keyValueSchema } from "../shared/contracts";
import { encodeKey } from "../shared/cell-encoding";
import { addressClause, writeBindValue } from "./addressing";
import { describeColumns, hasRowId, primaryKeyColumns, quoteIdentifier } from "./schema";

type ColumnAssignment = z.infer<typeof columnAssignmentSchema>;
type KeyValue = z.infer<typeof keyValueSchema>;

function assertKnownColumns(db: DatabaseSync, object: string, assignments: readonly ColumnAssignment[]): void {
  const columns = describeColumns(db, object).columns;
  for (const assignment of assignments) {
    const column = columns.find((entry) => entry.name === assignment.column);
    if (!column) throw new Error(`Unknown column: ${assignment.column}`);
    if (column.hidden !== "normal") {
      throw new Error(`${assignment.column} is generated or hidden and cannot be written.`);
    }
  }
}

/** Compare-and-set guard: every column the user saw must still hold its old value. */
function conflictGuard(
  db: DatabaseSync,
  object: string,
  expected: readonly ColumnAssignment[] | null | undefined,
): { sql: string; params: unknown[] } {
  if (!expected || expected.length === 0) return { sql: "", params: [] };
  assertKnownColumns(db, object, expected);
  return {
    sql: expected.map((entry) => `${quoteIdentifier(entry.column)} IS ?`).join(" and "),
    params: expected.map((entry) => writeBindValue(entry.value)),
  };
}

/** Distinguishes "someone else changed this row" from "the row is gone". */
function describeMiss(db: DatabaseSync, object: string, address: { sql: string; params: unknown[] }): never {
  const present = db
    .prepare(`select 1 as present from ${quoteIdentifier(object)} where ${address.sql} limit 1`)
    .get(...(address.params as never[]));
  if (present) {
    throw new Error("This row changed since it was loaded. Reload the rows and apply the change again.");
  }
  throw new Error("No row matched, so nothing was written. Reload the rows and try again.");
}

function inTransaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec("begin immediate");
  try {
    const result = run();
    db.exec("commit");
    return result;
  } catch (error) {
    try {
      db.exec("rollback");
    } catch {
      // The transaction may already be gone; the original error is what matters.
    }
    throw error;
  }
}

export function insertRowOf(
  db: DatabaseSync,
  input: { object: string; values: readonly ColumnAssignment[] },
): { insertedKeys: KeyValue[][]; changes: number } {
  assertKnownColumns(db, input.object, input.values);
  const columns = input.values.map((assignment) => quoteIdentifier(assignment.column)).join(", ");
  const placeholders = input.values.map(() => "?").join(", ");
  const statement = db.prepare(
    `insert into ${quoteIdentifier(input.object)} (${columns}) values (${placeholders})`,
  );
  const changes = inTransaction(db, () => {
    const result = statement.run(...(input.values.map((assignment) => writeBindValue(assignment.value)) as never[]));
    return Number(result.changes ?? 0);
  });

  if (hasRowId(db, input.object)) {
    const row = db.prepare("select last_insert_rowid() as id").get() as { id?: number | bigint } | undefined;
    return { insertedKeys: [[encodeKey(row?.id ?? null)]], changes };
  }
  const primaryKey = primaryKeyColumns(db, input.object);
  const key = primaryKey.map((column) => {
    const assignment = input.values.find((entry) => entry.column === column);
    if (!assignment) throw new Error(`${column} is part of the primary key and needs a value.`);
    return encodeKey(writeBindValue(assignment.value));
  });
  return { insertedKeys: [key], changes };
}

export function updateRowOf(
  db: DatabaseSync,
  input: {
    object: string;
    key: readonly KeyValue[];
    changes: readonly ColumnAssignment[];
    expected?: readonly ColumnAssignment[] | null | undefined;
  },
): { changes: number } {
  assertKnownColumns(db, input.object, input.changes);
  const address = addressClause(db, input.object, input.key);
  const guard = conflictGuard(db, input.object, input.expected);
  const assignments = input.changes.map((entry) => `${quoteIdentifier(entry.column)} = ?`).join(", ");
  const where = guard.sql.length > 0 ? `${address.sql} and ${guard.sql}` : address.sql;
  const statement = db.prepare(`update ${quoteIdentifier(input.object)} set ${assignments} where ${where}`);
  const params = [...input.changes.map((entry) => writeBindValue(entry.value)), ...address.params, ...guard.params];
  const changes = inTransaction(db, () => {
    const result = statement.run(...(params as never[]));
    return Number(result.changes ?? 0);
  });
  if (changes === 0) describeMiss(db, input.object, address);
  return { changes };
}

export function deleteRowOf(
  db: DatabaseSync,
  input: { object: string; key: readonly KeyValue[]; expected?: readonly ColumnAssignment[] | null | undefined },
): { changes: number } {
  const address = addressClause(db, input.object, input.key);
  const guard = conflictGuard(db, input.object, input.expected);
  const where = guard.sql.length > 0 ? `${address.sql} and ${guard.sql}` : address.sql;
  const statement = db.prepare(`delete from ${quoteIdentifier(input.object)} where ${where}`);
  const params = [...address.params, ...guard.params];
  const changes = inTransaction(db, () => {
    const result = statement.run(...(params as never[]));
    return Number(result.changes ?? 0);
  });
  if (changes === 0) describeMiss(db, input.object, address);
  return { changes };
}
