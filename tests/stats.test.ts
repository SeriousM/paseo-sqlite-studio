import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEngine } from "../server/engine";
import { readStatsOf } from "../server/handlers";

const directories: string[] = [];
const engines: SqliteEngine[] = [];

const AMOUNTS = Array.from({ length: 500 }, (_entry, index) => (index % 10 === 0 ? null : index + 1));

async function fixture(): Promise<{ engine: SqliteEngine; handleId: string }> {
  const directory = mkdtempSync(join(tmpdir(), "paseo-sqlite-stats-"));
  directories.push(directory);
  const path = join(directory, "stats.db");
  const db = new DatabaseSync(path);
  db.exec("create table ledger(id integer primary key, amount integer, label text, paid integer)");
  const insert = db.prepare("insert into ledger(amount, label, paid) values (?, ?, ?)");
  db.exec("begin");
  AMOUNTS.forEach((amount, index) => {
    insert.run(amount, `entry-${index + 1}`, index % 2);
  });
  db.exec("commit");
  db.close();

  const engine = new SqliteEngine();
  engines.push(engine);
  const opened = await engine.open(path);
  if (!opened.ok) throw new Error("fixture database did not open");
  return { engine, handleId: opened.entry.handleId };
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

describe("column statistics", () => {
  it("aggregates a numeric column over the whole table", async () => {
    const { engine, handleId } = await fixture();
    const stats = await readStatsOf(engine, { handleId, object: "ledger", column: "amount" });
    const present = AMOUNTS.filter((amount): amount is number => amount !== null);
    const sum = present.reduce((total, amount) => total + amount, 0);
    expect(stats.numeric).toBe(true);
    expect(stats.rows).toBe(500);
    expect(stats.values).toBe(present.length);
    expect(stats.nulls).toBe(50);
    expect(stats.sum).toBe(sum);
    expect(stats.average).toBeCloseTo(sum / present.length, 6);
    expect(stats.min).toBe(Math.min(...present));
    expect(stats.max).toBe(Math.max(...present));
  });

  it("reports only counts and extremes for a text column", async () => {
    const { engine, handleId } = await fixture();
    const stats = await readStatsOf(engine, { handleId, object: "ledger", column: "label" });
    expect(stats.numeric).toBe(false);
    expect(stats.sum).toBeNull();
    expect(stats.average).toBeNull();
    expect(stats.rows).toBe(500);
    expect(stats.values).toBe(500);
    // Text comparison uses SQLite's default BINARY collation, so derive it rather than guess.
    const labels = [...AMOUNTS.map((_amount, index) => `entry-${index + 1}`)].sort();
    expect(stats.min).toBe(labels[0]);
    expect(stats.max).toBe(labels.at(-1));
  });

  it("honours filters, so the numbers match what the grid shows", async () => {
    const { engine, handleId } = await fixture();
    const stats = await readStatsOf(engine, {
      handleId,
      object: "ledger",
      column: "amount",
      filters: [{ column: "paid", operator: "eq", value: "1" }],
    });
    const matching = AMOUNTS.filter((amount, index) => index % 2 === 1);
    const present = matching.filter((amount): amount is number => amount !== null);
    expect(stats.rows).toBe(250);
    expect(stats.values).toBe(present.length);
    expect(stats.sum).toBe(present.reduce((total, amount) => total + amount, 0));
  });

  it("counts a filtered search the same way", async () => {
    const { engine, handleId } = await fixture();
    const stats = await readStatsOf(engine, {
      handleId,
      object: "ledger",
      column: "label",
      search: "entry-1",
    });
    expect(stats.rows).toBeGreaterThan(0);
    expect(stats.rows).toBeLessThan(500);
    expect(stats.min).toBe("entry-1");
  });

  it("rejects an unknown column", async () => {
    const { engine, handleId } = await fixture();
    await expect(readStatsOf(engine, { handleId, object: "ledger", column: "missing" })).rejects.toThrow(/unknown column/i);
  });

  it("reports zero values for an empty result", async () => {
    const { engine, handleId } = await fixture();
    const stats = await readStatsOf(engine, {
      handleId,
      object: "ledger",
      column: "amount",
      filters: [{ column: "label", operator: "eq", value: "nothing" }],
    });
    expect(stats.rows).toBe(0);
    expect(stats.values).toBe(0);
    expect(stats.nulls).toBe(0);
    expect(stats.min).toBeNull();
    expect(stats.max).toBeNull();
  });
});
