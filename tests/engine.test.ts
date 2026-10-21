import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEngine, probeFile } from "../server/engine";

const temporaryDirectories: string[] = [];
const engines: SqliteEngine[] = [];

function createEngine(): SqliteEngine {
  const engine = new SqliteEngine();
  engines.push(engine);
  return engine;
}

function scratchDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "paseo-sqlite-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createDatabase(path: string, sql: string): void {
  const db = new DatabaseSync(path);
  db.exec(sql);
  db.close();
}

/**
 * Holds an EXCLUSIVE write lock from a second connection. A read-only open
 * fails with "database is locked" while this connection lives, which is the
 * condition the snapshot fallback exists for.
 */
function holdExclusiveLock(path: string): DatabaseSync {
  const holder = new DatabaseSync(path);
  holder.exec("pragma locking_mode = exclusive");
  holder.exec("begin exclusive");
  holder.exec("update t set b = 'held' where a = 1");
  return holder;
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
  for (const directory of temporaryDirectories.splice(0)) {
    // Windows can keep a handle briefly after a failed assertion; temp dirs are disposable.
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      continue;
    }
  }
});

describe("probeFile", () => {
  it("recognizes a SQLite database by its header", () => {
    const path = join(scratchDirectory(), "app.db");
    createDatabase(path, "create table t(a integer primary key, b text)");
    const probe = probeFile(path);
    expect(probe.exists).toBe(true);
    expect(probe.isSqlite).toBe(true);
    expect(probe.readable).toBe(true);
    expect(probe.sizeBytes).toBeGreaterThan(0);
  });

  it("reports a text file as not a database", () => {
    const path = join(scratchDirectory(), "notes.txt");
    writeFileSync(path, "hello, this is not a database");
    expect(probeFile(path).isSqlite).toBe(false);
  });

  it("reports a missing file", () => {
    const probe = probeFile(join(scratchDirectory(), "absent.db"));
    expect(probe.exists).toBe(false);
    expect(probe.isSqlite).toBe(false);
  });
});

describe("SqliteEngine.open", () => {
  it("opens a database read-only and rejects writes", () => {
    const path = join(scratchDirectory(), "app.db");
    createDatabase(path, "create table t(a integer primary key, b text); insert into t(b) values ('x')");
    const engine = createEngine();
    const outcome = engine.open(path);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const rows = outcome.entry.db.prepare("select b from t").all();
    expect(rows).toEqual([{ b: "x" }]);
    expect(() => outcome.entry.db.exec("insert into t(b) values ('y')")).toThrow(/readonly/i);
    expect(outcome.entry.snapshotPath).toBeNull();
    engine.dispose();
  });

  it("refuses a file that is not a SQLite database", () => {
    const path = join(scratchDirectory(), "fake.db");
    writeFileSync(path, "definitely not sqlite");
    const engine = createEngine();
    const outcome = engine.open(path);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("not-a-database");
    expect(outcome.error.canSnapshot).toBe(false);
    engine.dispose();
  });

  it("refuses a directory", () => {
    const engine = createEngine();
    const outcome = engine.open(scratchDirectory());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("permission");
    engine.dispose();
  });

  it("falls back to a snapshot while another connection holds an exclusive lock", () => {
    const path = join(scratchDirectory(), "locked.db");
    createDatabase(path, "create table t(a integer primary key, b text); insert into t values (1, 'x')");
    const engine = createEngine();
    const holder = holdExclusiveLock(path);

    try {
      const outcome = engine.open(path);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.entry.snapshotPath).not.toBeNull();
      expect(outcome.entry.warnings.join(" ")).toMatch(/snapshot/i);
      const row = outcome.entry.db.prepare("select count(*) as c from t").get() as { c: number | bigint };
      expect(Number(row.c)).toBe(1);
      const snapshotPath = outcome.entry.snapshotPath ?? "";
      expect(probeFile(snapshotPath).isSqlite).toBe(true);
      engine.close(outcome.entry.handleId);
      expect(probeFile(snapshotPath).exists).toBe(false);
    } finally {
      holder.exec("commit");
      holder.close();
    }

    // After the lock is released the same file opens directly again.
    const after = engine.open(path);
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.entry.snapshotPath).toBeNull();
    engine.dispose();
  });

  it("opens a snapshot copy on request even without a lock", () => {
    const path = join(scratchDirectory(), "wal.db");
    createDatabase(path, "pragma journal_mode = wal; create table t(a integer primary key, b text); insert into t values (1, 'x')");
    const engine = createEngine();
    const outcome = engine.open(path, "snapshot");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.entry.snapshotPath).not.toBeNull();
    const row = outcome.entry.db.prepare("select count(*) as c from t").get() as { c: number | bigint };
    expect(Number(row.c)).toBe(1);
    engine.dispose();
  });

  it("closes a handle and forgets it", () => {
    const path = join(scratchDirectory(), "app.db");
    createDatabase(path, "create table t(a integer)");
    const engine = createEngine();
    const outcome = engine.open(path);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { handleId } = outcome.entry;
    expect(engine.close(handleId)).toBe(true);
    expect(engine.close(handleId)).toBe(false);
    expect(() => engine.get(handleId)).toThrow(/no longer open/i);
    engine.dispose();
  });

  it("deletes the snapshot file when the handle closes", () => {
    const path = join(scratchDirectory(), "wal.db");
    createDatabase(path, "pragma journal_mode = wal; create table t(a integer)");
    const engine = createEngine();
    const outcome = engine.open(path, "snapshot");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { snapshotPath, handleId } = outcome.entry;
    expect(snapshotPath).not.toBeNull();
    engine.close(handleId);
    expect(probeFile(snapshotPath ?? "").exists).toBe(false);
    engine.dispose();
  });
});
