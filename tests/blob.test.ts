import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEngine } from "../server/engine";
import { saveBlobOf } from "../server/handlers";

const directories: string[] = [];
const engines: SqliteEngine[] = [];

const PAYLOAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);

async function fixture(): Promise<{ engine: SqliteEngine; handleId: string; directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), "paseo-sqlite-blob-"));
  directories.push(directory);
  const path = join(directory, "blobs.db");
  const db = new DatabaseSync(path);
  db.exec("create table files(id integer primary key, name text, data blob)");
  const insert = db.prepare("insert into files(name, data) values (?, ?)");
  insert.run("logo", PAYLOAD);
  insert.run("empty", null);
  db.close();

  const engine = new SqliteEngine();
  engines.push(engine);
  const opened = await engine.open(path);
  if (!opened.ok) throw new Error("fixture database did not open");
  return { engine, handleId: opened.entry.handleId, directory };
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

describe("saving a binary cell", () => {
  it("writes the exact bytes to the chosen path", async () => {
    const { engine, handleId, directory } = await fixture();
    const target = join(directory, "logo.png");
    const result = saveBlobOf(engine, { handleId, object: "files", column: "data", key: [1], targetPath: target });
    expect(result).toEqual({ path: target, bytes: PAYLOAD.length });
    expect(new Uint8Array(readFileSync(target))).toEqual(PAYLOAD);
  });

  it("refuses to replace an existing file without permission", async () => {
    const { engine, handleId, directory } = await fixture();
    const target = join(directory, "logo.png");
    writeFileSync(target, "old");
    expect(() =>
      saveBlobOf(engine, { handleId, object: "files", column: "data", key: [1], targetPath: target }),
    ).toThrow(/already exists/i);
    expect(readFileSync(target, "utf8")).toBe("old");
    expect(
      saveBlobOf(engine, {
        handleId,
        object: "files",
        column: "data",
        key: [1],
        targetPath: target,
        overwrite: true,
      }).bytes,
    ).toBe(PAYLOAD.length);
    expect(new Uint8Array(readFileSync(target))).toEqual(PAYLOAD);
  });

  it("refuses NULL and non-binary cells", async () => {
    const { engine, handleId, directory } = await fixture();
    expect(() =>
      saveBlobOf(engine, { handleId, object: "files", column: "data", key: [2], targetPath: join(directory, "x.bin") }),
    ).toThrow(/null/i);
    expect(() =>
      saveBlobOf(engine, { handleId, object: "files", column: "name", key: [1], targetPath: join(directory, "y.txt") }),
    ).toThrow(/binary/i);
  });

  it("rejects an unknown column", async () => {
    const { engine, handleId, directory } = await fixture();
    expect(() =>
      saveBlobOf(engine, { handleId, object: "files", column: "missing", key: [1], targetPath: join(directory, "z.bin") }),
    ).toThrow(/unknown column/i);
  });
});
