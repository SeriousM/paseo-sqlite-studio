import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { KeyValue } from "../shared/contracts";
import { buildRowQuery, runRowQuery, runSql } from "../server/rows";
import { encodeCell, encodeKey } from "../server/values";

const directories: string[] = [];
const databases: DatabaseSync[] = [];

function fixtureDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "paseo-sqlite-rows-"));
  directories.push(directory);
  const db = new DatabaseSync(join(directory, "rows.db"));
  databases.push(db);
  db.exec(`
    create table items(
      id integer primary key,
      name text,
      quantity integer,
      price real,
      note text,
      payload blob
    );
  `);
  const insert = db.prepare("insert into items(name, quantity, price, note, payload) values (?, ?, ?, ?, ?)");
  db.exec("begin");
  for (let index = 1; index <= 500; index += 1) {
    insert.run(
      `item-${String(index).padStart(3, "0")}`,
      index,
      index / 2,
      index % 5 === 0 ? null : `note ${index}`,
      new Uint8Array([index % 256, 1, 2, 3]),
    );
  }
  db.exec("commit");
  db.exec("create table keyed(code text primary key, label text) without rowid");
  db.exec("insert into keyed values ('a', 'first'), ('b', 'second')");
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // Already closed by the test itself.
    }
  }
  for (const directory of directories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Windows can keep a handle briefly after a failed assertion.
    }
  }
});

describe("value encoding", () => {
  it("clips long text and blobs into previews", () => {
    expect(encodeCell("short")).toBe("short");
    const long = "x".repeat(5000);
    expect(encodeCell(long)).toEqual({ kind: "longtext", size: 5000, preview: "x".repeat(4096) });
    const blob = encodeCell(new Uint8Array([1, 2, 3]));
    expect(blob).toEqual({ kind: "blob", size: 3, previewHex: Buffer.from([1, 2, 3]).toString("hex") });
    expect(encodeCell(null)).toBeNull();
  });

  it("keeps integers beyond the safe range as strings", () => {
    expect(encodeCell(12n)).toBe(12);
    expect(encodeCell(9_007_199_254_740_993n)).toEqual({ kind: "bigint", value: "9007199254740993" });
    expect(encodeKey(9_007_199_254_740_993n)).toEqual({ kind: "bigint", value: "9007199254740993" });
  });
});

describe("buildRowQuery", () => {
  it("quotes identifiers and orders by the row identity by default", () => {
    const db = fixtureDatabase();
    const query = buildRowQuery(db, { object: "items", limit: 10 });
    expect(query.sql).toBe(
      'select rowid as "__paseo_rowid__", "id", "name", "quantity", "price", "note", "payload" from "items" order by "rowid" asc limit 10',
    );
    db.close();
  });

  it("parameterizes filters instead of interpolating values", () => {
    const db = fixtureDatabase();
    const query = buildRowQuery(db, {
      object: "items",
      limit: 5,
      filters: [{ column: "name", operator: "contains", value: "100%_x" }],
    });
    expect(query.sql).toContain('CAST("name" AS TEXT) LIKE ? ESCAPE');
    expect(query.params).toEqual(["%100\\%\\_x%"]);
    db.close();
  });

  it("rejects unknown columns", () => {
    const db = fixtureDatabase();
    expect(() => buildRowQuery(db, { object: "items", limit: 5, filters: [{ column: "nope", operator: "eq", value: "1" }] })).toThrow(
      /unknown column/i,
    );
    db.close();
  });
});

describe("runRowQuery", () => {
  it("returns a page, reports more rows, and hands back a cursor", () => {
    const db = fixtureDatabase();
    const page = runRowQuery(db, { object: "items", limit: 10 });
    expect(page.rows).toHaveLength(10);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual([10]);
    expect(page.columns.map((column) => column.name)).toEqual(["id", "name", "quantity", "price", "note", "payload"]);
    expect(page.rows[0]?.[1]).toBe("item-001");
    db.close();
  });

  it("pages with a cursor without repeating or skipping rows", () => {
    const db = fixtureDatabase();
    const first = runRowQuery(db, { object: "items", limit: 10 });
    const second = runRowQuery(db, { object: "items", limit: 10, cursor: first.nextCursor });
    expect(second.rows[0]?.[0]).toBe(11);
    const firstIds = first.rows.map((row) => row[0]);
    const secondIds = second.rows.map((row) => row[0]);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
    db.close();
  });

  it("pages with an offset when a cursor is not supplied", () => {
    const db = fixtureDatabase();
    const page = runRowQuery(db, { object: "items", limit: 5, offset: 495 });
    expect(page.rows.map((row) => row[0])).toEqual([496, 497, 498, 499, 500]);
    expect(page.hasMore).toBe(false);
    db.close();
  });

  it("applies filters, search, and sorting", () => {
    const db = fixtureDatabase();
    const filtered = runRowQuery(db, {
      object: "items",
      limit: 1000,
      filters: [{ column: "note", operator: "isNull" }],
    });
    expect(filtered.rows).toHaveLength(100);
    expect(filtered.rows.every((row) => row[4] === null)).toBe(true);

    const searched = runRowQuery(db, { object: "items", limit: 10, search: "note 12" });
    expect(searched.rows.length).toBeGreaterThan(0);
    expect(searched.rows.every((row) => String(row[4]).includes("note 12"))).toBe(true);

    const sorted = runRowQuery(db, {
      object: "items",
      limit: 3,
      sort: [{ column: "id", direction: "desc" }],
    });
    expect(sorted.rows.map((row) => row[0])).toEqual([500, 499, 498]);

    const counted = runRowQuery(db, {
      object: "items",
      limit: 1,
      filters: [{ column: "quantity", operator: "gte", value: "100" }],
      countExact: true,
    });
    expect(counted.rowCount).toBe(401);
    db.close();
  });

  it("limits the requested columns but keeps the row identity", () => {
    const db = fixtureDatabase();
    const page = runRowQuery(db, { object: "items", limit: 2, columns: ["name"] });
    expect(page.columns.map((column) => column.name)).toEqual(["name"]);
    expect(page.keys).toEqual([[1], [2]]);
    db.close();
  });

  it("uses primary-key keys for WITHOUT ROWID tables", () => {
    const db = fixtureDatabase();
    const page = runRowQuery(db, { object: "keyed", limit: 10 });
    expect(page.keys).toEqual([["a"], ["b"]] as KeyValue[][]);
    expect(page.rows.map((row) => row[1])).toEqual(["first", "second"]);
    db.close();
  });

  it("counts rows exactly only when asked", () => {
    const db = fixtureDatabase();
    expect(runRowQuery(db, { object: "items", limit: 5 }).rowCount).toBeNull();
    expect(runRowQuery(db, { object: "items", limit: 5, countExact: true }).rowCount).toBe(500);
    db.close();
  });
});

describe("runSql", () => {
  it("runs a select and caps the result", () => {
    const db = fixtureDatabase();
    const result = runSql(db, "select id, name from items order by id", 5);
    expect(result.returnedRows).toBe(true);
    expect(result.rows).toHaveLength(5);
    expect(result.hasMore).toBe(true);
    expect(result.columns.map((column) => column.name)).toEqual(["id", "name"]);
    db.close();
  });

  it("reports changes for a statement that returns no rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-sqlite-write-"));
    directories.push(directory);
    const db = new DatabaseSync(join(directory, "write.db"));
    db.exec("create table t(a integer); insert into t values (1), (2)");
    const result = runSql(db, "update t set a = a + 1", 10);
    expect(result.returnedRows).toBe(false);
    expect(result.changes).toBe(2);
    db.close();
  });

  it("surfaces SQL errors", () => {
    const db = fixtureDatabase();
    expect(() => runSql(db, "select * from missing", 10)).toThrow(/no such table/i);
    db.close();
  });
});
