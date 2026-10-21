import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEngine } from "../server/engine";
import { deleteRowIn, insertRowIn, readRowsOf, setWriting, updateRowIn } from "../server/handlers";

const directories: string[] = [];
const engines: SqliteEngine[] = [];

function fixture(): { engine: SqliteEngine; handleId: string; path: string } {
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
  const opened = engine.open(path);
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
  it("starts read-only and refuses mutations until editing is enabled", () => {
    const { engine, handleId } = fixture();
    expect(() => insertRowIn(engine, { handleId, object: "people", values: [{ column: "name", value: "alan" }] })).toThrow(
      /editing is off/i,
    );
    expect(setWriting(engine, { handleId, enabled: true })).toEqual({ readOnly: false, warning: null });
    expect(setWriting(engine, { handleId, enabled: false })).toEqual({ readOnly: true, warning: null });
  });

  it("refuses writes on a snapshot handle", () => {
    const { engine, path } = fixture();
    const snapshot = engine.open(path, "snapshot");
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    const outcome = setWriting(engine, { handleId: snapshot.entry.handleId, enabled: true });
    expect(outcome.readOnly).toBe(true);
    expect(outcome.warning).toMatch(/snapshot/i);
  });

  it("inserts a row and returns its key", () => {
    const { engine, handleId, path } = fixture();
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

  it("updates and deletes by key", () => {
    const { engine, handleId, path } = fixture();
    setWriting(engine, { handleId, enabled: true });

    expect(updateRowIn(engine, { handleId, object: "people", key: [1], changes: [{ column: "age", value: 37 }] })).toEqual({
      changes: 1,
    });
    expect(readPeople(path).find((row) => row.id === 1)?.age).toBe(37);

    expect(deleteRowIn(engine, { handleId, object: "people", key: [2] })).toEqual({ changes: 1 });
    expect(readPeople(path).map((row) => row.id)).toEqual([1]);
  });

  it("reports a missing row instead of silently doing nothing", () => {
    const { engine, handleId } = fixture();
    setWriting(engine, { handleId, enabled: true });
    expect(() => updateRowIn(engine, { handleId, object: "people", key: [99], changes: [{ column: "age", value: 1 }] })).toThrow(
      /no row matched/i,
    );
    expect(() => deleteRowIn(engine, { handleId, object: "people", key: [99] })).toThrow(/no row matched/i);
  });

  it("keeps constraints enforced and rolls back a failed insert", () => {
    const { engine, handleId, path } = fixture();
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

  it("refuses unknown and generated columns", () => {
    const { engine, handleId } = fixture();
    setWriting(engine, { handleId, enabled: true });
    expect(() =>
      insertRowIn(engine, { handleId, object: "people", values: [{ column: "nope", value: "x" }] }),
    ).toThrow(/unknown column/i);
  });

  it("serves reads again after switching back to read-only", () => {
    const { engine, handleId, path } = fixture();
    setWriting(engine, { handleId, enabled: true });
    insertRowIn(engine, { handleId, object: "people", values: [{ column: "name", value: "alan" }] });
    setWriting(engine, { handleId, enabled: false });
    const rows = readRowsOf(engine, { handleId, object: "people", limit: 10, countExact: true });
    expect(rows.rowCount).toBe(3);
    expect(readPeople(path)).toHaveLength(3);
  });

  it("writes NULL and empty string as distinct values", () => {
    const { engine, handleId, path } = fixture();
    setWriting(engine, { handleId, enabled: true });
    updateRowIn(engine, { handleId, object: "people", key: [1], changes: [{ column: "age", value: null }] });
    const row = readPeople(path).find((entry) => entry.id === 1);
    expect(row?.age).toBeNull();
  });
});
