import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEngine } from "../server/engine";
import { deleteRowIn, insertRowIn, readRowsOf, setWriting, updateRowIn } from "../server/handlers";

const directories: string[] = [];
const engines: SqliteEngine[] = [];

async function fixture(): Promise<{ engine: SqliteEngine; handleId: string; path: string }> {
  const directory = mkdtempSync(join(tmpdir(), "paseo-sqlite-write-"));
  directories.push(directory);
  const path = join(directory, "editable.db");
  const db = new DatabaseSync(path);
  db.exec(`
    create table people(
      id integer primary key,
      name text not null unique,
      age integer,
      team_id integer references teams(id)
    );
    create table teams(id integer primary key, name text not null);
    insert into teams values (1, 'alpha'), (2, 'beta');
    insert into people values (1, 'ada', 36, 1), (2, 'grace', 45, 2);
  `);
  db.close();

  const engine = new SqliteEngine();
  engines.push(engine);
  const opened = await engine.open(path);
  if (!opened.ok) throw new Error("fixture database did not open");
  return { engine, handleId: opened.entry.handleId, path };
}

function readPeople(path: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db.prepare("select id, name, age, team_id from people order by id").all();
  db.close();
  return rows as Array<Record<string, unknown>>;
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

describe("write mode", () => {
  it("starts read-only and refuses mutations until editing is enabled", async () => {
    const { engine, handleId } = await fixture();
    expect(() => insertRowIn(engine, { handleId, object: "people", values: [{ column: "name", value: "alan" }] })).toThrow(
      /editing is off/i,
    );
    expect(setWriting(engine, { handleId, enabled: true })).toEqual({ readOnly: false, warning: null });
    expect(setWriting(engine, { handleId, enabled: false })).toEqual({ readOnly: true, warning: null });
  });

  it("refuses writes on a snapshot handle", async () => {
    const { engine, path } = await fixture();
    const snapshot = await engine.open(path, "snapshot");
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    const outcome = setWriting(engine, { handleId: snapshot.entry.handleId, enabled: true });
    expect(outcome.readOnly).toBe(true);
    expect(outcome.warning).toMatch(/snapshot/i);
  });

  it("inserts a row and returns its key", async () => {
    const { engine, handleId, path } = await fixture();
    setWriting(engine, { handleId, enabled: true });
    const result = insertRowIn(engine, {
      handleId,
      object: "people",
      values: [
        { column: "name", value: "alan" },
        { column: "age", value: 41 },
        { column: "team_id", value: 1 },
      ],
    });
    expect(result.changes).toBe(1);
    expect(result.insertedKeys).toEqual([[3]]);
    expect(readPeople(path)).toHaveLength(3);
  });

  it("updates and deletes by key", async () => {
    const { engine, handleId, path } = await fixture();
    setWriting(engine, { handleId, enabled: true });

    expect(updateRowIn(engine, { handleId, object: "people", key: [1], changes: [{ column: "age", value: 37 }] })).toEqual({
      changes: 1,
    });
    expect(readPeople(path).find((row) => row.id === 1)?.age).toBe(37);

    expect(deleteRowIn(engine, { handleId, object: "people", key: [2] })).toEqual({ changes: 1 });
    expect(readPeople(path).map((row) => row.id)).toEqual([1]);
  });

  it("reports a missing row instead of silently doing nothing", async () => {
    const { engine, handleId } = await fixture();
    setWriting(engine, { handleId, enabled: true });
    expect(() => updateRowIn(engine, { handleId, object: "people", key: [99], changes: [{ column: "age", value: 1 }] })).toThrow(
      /no row matched/i,
    );
    expect(() => deleteRowIn(engine, { handleId, object: "people", key: [99] })).toThrow(/no row matched/i);
  });

  it("keeps constraints enforced and rolls back a failed insert", async () => {
    const { engine, handleId, path } = await fixture();
    setWriting(engine, { handleId, enabled: true });
    expect(() =>
      insertRowIn(engine, {
        handleId,
        object: "people",
        values: [
          { column: "name", value: "ada" },
          { column: "team_id", value: 999 },
        ],
      }),
    ).toThrow();
    expect(readPeople(path)).toHaveLength(2);
  });

  it("refuses to overwrite a row that changed since it was loaded", async () => {
    const { engine, handleId, path } = await fixture();
    setWriting(engine, { handleId, enabled: true });

    const other = new DatabaseSync(path);
    other.exec("update people set age = 99 where id = 1");
    other.close();

    expect(() =>
      updateRowIn(engine, {
        handleId,
        object: "people",
        key: [1],
        changes: [{ column: "age", value: 37 }],
        expected: [{ column: "age", value: 36 }],
      }),
    ).toThrow(/changed since/i);

    // With the current value as the expectation the write goes through.
    expect(
      updateRowIn(engine, {
        handleId,
        object: "people",
        key: [1],
        changes: [{ column: "age", value: 37 }],
        expected: [{ column: "age", value: 99 }],
      }),
    ).toEqual({ changes: 1 });
    expect(readPeople(path).find((row) => row.id === 1)?.age).toBe(37);
  });

  it("refuses to delete a row that changed since it was loaded", async () => {
    const { engine, handleId, path } = await fixture();
    setWriting(engine, { handleId, enabled: true });

    const other = new DatabaseSync(path);
    other.exec("update people set name = 'ada l' where id = 1");
    other.close();

    expect(() =>
      deleteRowIn(engine, {
        handleId,
        object: "people",
        key: [1],
        expected: [{ column: "name", value: "ada" }],
      }),
    ).toThrow(/changed since/i);
    expect(readPeople(path)).toHaveLength(2);
  });

  it("refuses unknown and generated columns", async () => {
    const { engine, handleId } = await fixture();
    setWriting(engine, { handleId, enabled: true });
    expect(() =>
      insertRowIn(engine, { handleId, object: "people", values: [{ column: "nope", value: "x" }] }),
    ).toThrow(/unknown column/i);
  });

  it("serves reads again after switching back to read-only", async () => {
    const { engine, handleId, path } = await fixture();
    setWriting(engine, { handleId, enabled: true });
    insertRowIn(engine, { handleId, object: "people", values: [{ column: "name", value: "alan" }] });
    setWriting(engine, { handleId, enabled: false });
    const rows = await readRowsOf(engine, { handleId, object: "people", limit: 10, countExact: true });
    expect(rows.rowCount).toBe(3);
    expect(readPeople(path)).toHaveLength(3);
  });

  it("writes NULL and empty string as distinct values", async () => {
    const { engine, handleId, path } = await fixture();
    setWriting(engine, { handleId, enabled: true });
    updateRowIn(engine, { handleId, object: "people", key: [1], changes: [{ column: "age", value: null }] });
    const row = readPeople(path).find((entry) => entry.id === 1);
    expect(row?.age).toBeNull();
  });
});

describe("row identity", () => {
  async function identityFixture(): Promise<{ engine: SqliteEngine; handleId: string; path: string }> {
    const directory = mkdtempSync(join(tmpdir(), "paseo-sqlite-identity-"));
    directories.push(directory);
    const path = join(directory, "identity.db");
    const db = new DatabaseSync(path);
    db.exec(`
      create table notes(rowid text, body text);
      insert into notes values ('duplicate', 'same'), ('duplicate', 'same');
      create table tri(rowid text, _rowid_ text, oid text, body text);
      insert into tri values ('duplicate', 'duplicate', 'duplicate', 'same'),
                             ('duplicate', 'duplicate', 'duplicate', 'same');
      create table shadowed_key(rowid text, id integer primary key, body text);
      insert into shadowed_key values ('duplicate', 1, 'first'), ('duplicate', 2, 'second');
      create table collision(__paseo_rowid__ integer, payload blob);
      insert into collision values (2, x'AA'), (2, x'BB');
    `);
    db.close();

    const engine = new SqliteEngine();
    engines.push(engine);
    const opened = await engine.open(path);
    if (!opened.ok) throw new Error("fixture database did not open");
    setWriting(engine, { handleId: opened.entry.handleId, enabled: true });
    return { engine, handleId: opened.entry.handleId, path };
  }

  function readNotes(path: string): Array<{ rowid: string; body: string }> {
    const db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare("select rowid, body from notes order by _rowid_").all();
    db.close();
    return rows as Array<{ rowid: string; body: string }>;
  }

  it("addresses duplicate rows by an unshadowed rowid alias", async () => {
    const { engine, handleId, path } = await identityFixture();
    const page = await readRowsOf(engine, { handleId, object: "notes", limit: 10 });
    expect(page.keys).toHaveLength(2);
    expect(page.keys[0]).not.toEqual(page.keys[1]);

    expect(deleteRowIn(engine, { handleId, object: "notes", key: page.keys[0]!, expected: null })).toEqual({ changes: 1 });
    expect(readNotes(path)).toEqual([{ rowid: "duplicate", body: "same" }]);
  });

  it("updates one duplicate row and leaves the other alone", async () => {
    const { engine, handleId, path } = await identityFixture();
    const page = await readRowsOf(engine, { handleId, object: "notes", limit: 10 });
    expect(updateRowIn(engine, { handleId, object: "notes", key: page.keys[1]!, changes: [{ column: "body", value: "changed" }] })).toEqual({ changes: 1 });
    expect(readNotes(path)).toEqual([
      { rowid: "duplicate", body: "same" },
      { rowid: "duplicate", body: "changed" },
    ]);
  });

  it("uses the primary key when every rowid name is shadowed", async () => {
    const { engine, handleId } = await identityFixture();
    const page = await readRowsOf(engine, { handleId, object: "shadowed_key", limit: 10 });
    expect(page.keys).toEqual([[1], [2]]);
    expect(
      updateRowIn(engine, {
        handleId,
        object: "shadowed_key",
        key: page.keys[0]!,
        changes: [{ column: "body", value: "changed" }],
      }),
    ).toEqual({ changes: 1 });
    const rows = await readRowsOf(engine, { handleId, object: "shadowed_key", limit: 10 });
    expect(rows.rows.map((row) => row[2])).toEqual(["changed", "second"]);
  });

  it("refuses every write when no identity exists and nothing is written", async () => {
    const { engine, handleId, path } = await identityFixture();
    const page = await readRowsOf(engine, { handleId, object: "tri", limit: 10 });
    expect(page.keys.every((key) => key.length === 0)).toBe(true);

    expect(() => deleteRowIn(engine, { handleId, object: "tri", key: [], expected: null })).toThrow(
      /no primary key and no accessible rowid/i,
    );
    expect(() =>
      updateRowIn(engine, { handleId, object: "tri", key: [], changes: [{ column: "body", value: "changed" }] }),
    ).toThrow(/no primary key and no accessible rowid/i);
    expect(() => insertRowIn(engine, { handleId, object: "tri", values: [{ column: "body", value: "new" }] })).toThrow(
      /no primary key and no accessible rowid/i,
    );

    const db = new DatabaseSync(path, { readOnly: true });
    const count = db.prepare("select count(*) as c from tri").get() as { c: number };
    db.close();
    expect(count.c).toBe(2);
  });

  it("keeps the internal key separate from a user column with the same name", async () => {
    const { engine, handleId, path } = await identityFixture();
    const page = await readRowsOf(engine, { handleId, object: "collision", limit: 10 });
    expect(page.keys).toEqual([[1], [2]]);

    expect(deleteRowIn(engine, { handleId, object: "collision", key: page.keys[0]!, expected: null })).toEqual({
      changes: 1,
    });
    const db = new DatabaseSync(path, { readOnly: true });
    const remaining = db.prepare("select __paseo_rowid__ as marker, hex(payload) as payload from collision").all();
    db.close();
    expect(remaining).toEqual([{ marker: 2, payload: "BB" }]);
  });

  it("updates one row when a user column reuses the internal key name", async () => {
    const { engine, handleId, path } = await identityFixture();
    const page = await readRowsOf(engine, { handleId, object: "collision", limit: 10 });
    expect(
      updateRowIn(engine, {
        handleId,
        object: "collision",
        key: page.keys[0]!,
        changes: [{ column: "payload", value: { kind: "blob", base64: "zA==" } }],
      }),
    ).toEqual({ changes: 1 });

    const db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare("select hex(payload) as payload from collision order by rowid").all();
    db.close();
    expect(rows).toEqual([{ payload: "CC" }, { payload: "BB" }]);
  });
});
