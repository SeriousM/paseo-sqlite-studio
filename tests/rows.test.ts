import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEngine } from "../server/engine";
import { readRowsOf } from "../server/handlers";
import { buildRowQuery } from "../server/rows";
import { encodeCell, encodeKey } from "../shared/cell-encoding";

const directories: string[] = [];
const engines: SqliteEngine[] = [];

interface Fixture {
  engine: SqliteEngine;
  handleId: string;
}

async function fixture(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "paseo-sqlite-rows-"));
  directories.push(directory);
  const db = new DatabaseSync(join(directory, "rows.db"));
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
  db.close();

  const engine = new SqliteEngine();
  engines.push(engine);
  const opened = await engine.open(join(directory, "rows.db"));
  if (!opened.ok) throw new Error("fixture database did not open");
  return { engine, handleId: opened.entry.handleId };
}

function openDatabase(engine: SqliteEngine): DatabaseSync {
  const entry = engine.list()[0];
  if (!entry) throw new Error("fixture database is not open");
  return entry.db;
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
  for (const directory of directories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Windows can keep a handle briefly after a failed assertion.
    }
  }
});

describe("value encoding", () => {
  it("clips long text and blobs into previews", async () => {
    expect(encodeCell("short")).toBe("short");
    expect(encodeCell("x".repeat(5000))).toEqual({ kind: "longtext", size: 5000, preview: "x".repeat(4096) });
    expect(encodeCell(new Uint8Array([1, 2, 3]))).toEqual({
      kind: "blob",
      size: 3,
      previewHex: Buffer.from([1, 2, 3]).toString("hex"),
    });
    expect(encodeCell(null)).toBeNull();
  });

  it("keeps integers beyond the safe range as strings", async () => {
    expect(encodeCell(12n)).toBe(12);
    expect(encodeCell(9_007_199_254_740_993n)).toEqual({ kind: "bigint", value: "9007199254740993" });
    expect(encodeKey(9_007_199_254_740_993n)).toEqual({ kind: "bigint", value: "9007199254740993" });
  });
});

describe("buildRowQuery", () => {
  it("quotes identifiers and orders by the row identity by default", async () => {
    const { engine } = await fixture();
    const query = buildRowQuery(openDatabase(engine), { object: "items", limit: 10 });
    expect(query.sql).toBe(
      'select rowid as "__paseo_rowid__", "id", "name", "quantity", "price", "note", "payload" from "items" order by "rowid" asc limit 10',
    );
  });

  it("parameterizes filters instead of interpolating values", async () => {
    const { engine } = await fixture();
    const query = buildRowQuery(openDatabase(engine), {
      object: "items",
      limit: 5,
      filters: [{ column: "name", operator: "contains", value: "100%_x" }],
    });
    expect(query.sql).toContain('CAST("name" AS TEXT) LIKE ? ESCAPE');
    expect(query.params).toEqual(["%100\\%\\_x%"]);
  });

  it("rejects unknown columns", async () => {
    const { engine } = await fixture();
    expect(() =>
      buildRowQuery(openDatabase(engine), { object: "items", limit: 5, filters: [{ column: "nope", operator: "eq", value: "1" }] }),
    ).toThrow(/unknown column/i);
  });
});

describe("readRowsOf", () => {
  it("returns a page, reports more rows, and hands back a cursor", async () => {
    const { engine, handleId } = await fixture();
    const page = await readRowsOf(engine, { handleId, object: "items", limit: 10 });
    expect(page.rows).toHaveLength(10);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual([10]);
    expect(page.columns.map((column) => column.name)).toEqual(["id", "name", "quantity", "price", "note", "payload"]);
    expect(page.rows[0]?.[1]).toBe("item-001");
    expect(page.rows[0]?.[5]).toEqual(encodeCell(new Uint8Array([1, 1, 2, 3])));
    expect(page.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("pages with a cursor without repeating or skipping rows", async () => {
    const { engine, handleId } = await fixture();
    const first = await readRowsOf(engine, { handleId, object: "items", limit: 10 });
    const second = await readRowsOf(engine, { handleId, object: "items", limit: 10, cursor: first.nextCursor });
    expect(second.rows[0]?.[0]).toBe(11);
    const firstIds = first.rows.map((row) => row[0]);
    const secondIds = second.rows.map((row) => row[0]);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  });

  it("pages by key when sorting the identity descending", async () => {
    const { engine, handleId } = await fixture();
    const first = await readRowsOf(engine, {
      handleId,
      object: "items",
      limit: 10,
      sort: [{ column: "id", direction: "desc" }],
    });
    expect(first.rows.map((row) => row[0])).toEqual([500, 499, 498, 497, 496, 495, 494, 493, 492, 491]);
    expect(first.nextCursor).toEqual([491]);
    const second = await readRowsOf(engine, {
      handleId,
      object: "items",
      limit: 10,
      sort: [{ column: "id", direction: "desc" }],
      cursor: first.nextCursor,
    });
    expect(second.rows[0]?.[0]).toBe(490);
    expect(second.rows.some((row) => first.rows.some((seen) => seen[0] === row[0]))).toBe(false);
  });

  it("pages by key when sorting a unique column", async () => {
    const { engine, handleId } = await fixture();
    const first = await readRowsOf(engine, {
      handleId,
      object: "keyed",
      limit: 1,
      sort: [{ column: "code", direction: "asc" }],
    });
    expect(first.rows.map((row) => row[0])).toEqual(["a"]);
    expect(first.nextCursor).toEqual(["a"]);
    const second = await readRowsOf(engine, {
      handleId,
      object: "keyed",
      limit: 1,
      sort: [{ column: "code", direction: "asc" }],
      cursor: first.nextCursor,
    });
    expect(second.rows.map((row) => row[0])).toEqual(["b"]);
  });

  it("falls back to offset paging when the sort column allows duplicates", async () => {
    const { engine, handleId } = await fixture();
    const page = await readRowsOf(engine, {
      handleId,
      object: "items",
      limit: 5,
      sort: [{ column: "quantity", direction: "asc" }],
    });
    // quantity repeats across rows, so a key cursor would skip values.
    expect(page.nextCursor).toBeNull();
  });

  it("pages with an offset when a cursor is not supplied", async () => {
    const { engine, handleId } = await fixture();
    const page = await readRowsOf(engine, { handleId, object: "items", limit: 5, offset: 495 });
    expect(page.rows.map((row) => row[0])).toEqual([496, 497, 498, 499, 500]);
    expect(page.hasMore).toBe(false);
  });

  it("applies filters, search, and sorting", async () => {
    const { engine, handleId } = await fixture();
    const filtered = await readRowsOf(engine, {
      handleId,
      object: "items",
      limit: 1000,
      filters: [{ column: "note", operator: "isNull" }],
    });
    expect(filtered.rows).toHaveLength(100);
    expect(filtered.rows.every((row) => row[4] === null)).toBe(true);

    const searched = await readRowsOf(engine, { handleId, object: "items", limit: 10, search: "note 12" });
    expect(searched.rows.length).toBeGreaterThan(0);
    expect(searched.rows.every((row) => String(row[4]).includes("note 12"))).toBe(true);

    const sorted = await readRowsOf(engine, {
      handleId,
      object: "items",
      limit: 3,
      sort: [{ column: "id", direction: "desc" }],
    });
    expect(sorted.rows.map((row) => row[0])).toEqual([500, 499, 498]);

    const counted = await readRowsOf(engine, {
      handleId,
      object: "items",
      limit: 1,
      filters: [{ column: "quantity", operator: "gte", value: "100" }],
      countExact: true,
    });
    expect(counted.rowCount).toBe(401);
  });

  it("limits the requested columns but keeps the row identity", async () => {
    const { engine, handleId } = await fixture();
    const page = await readRowsOf(engine, { handleId, object: "items", limit: 2, columns: ["name"] });
    expect(page.columns.map((column) => column.name)).toEqual(["name"]);
    expect(page.keys).toEqual([[1], [2]]);
  });

  it("uses primary-key keys for WITHOUT ROWID tables", async () => {
    const { engine, handleId } = await fixture();
    const page = await readRowsOf(engine, { handleId, object: "keyed", limit: 10 });
    expect(page.keys).toEqual([["a"], ["b"]]);
    expect(page.rows.map((row) => row[1])).toEqual(["first", "second"]);
  });

  it("counts rows exactly only when asked", async () => {
    const { engine, handleId } = await fixture();
    expect((await readRowsOf(engine, { handleId, object: "items", limit: 5 })).rowCount).toBeNull();
    expect((await readRowsOf(engine, { handleId, object: "items", limit: 5, countExact: true })).rowCount).toBe(500);
  });

  it("surfaces SQL errors from the worker", async () => {
    const { engine, handleId } = await fixture();
    await expect(readRowsOf(engine, { handleId, object: "missing_table", limit: 5 })).rejects.toThrow(/no such table/i);
  });

  it("keeps the plugin thread free while a page is read", async () => {
    const { engine, handleId } = await fixture();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);
    await readRowsOf(engine, {
      handleId,
      object: "items",
      limit: 5,
      filters: [{ column: "name", operator: "endsWith", value: "0" }],
    });
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });
});
