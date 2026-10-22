import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listPath } from "../server/handlers";

const directories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "paseo-sqlite-listing-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Windows can keep a handle briefly after a failed assertion.
    }
  }
});

describe("directory listing", () => {
  it("returns directories first, then database files by extension", async () => {
    const root = scratch();
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "b.sqlite"), "");
    writeFileSync(join(root, "a.db"), "");
    writeFileSync(join(root, "c.sqlite3"), "");
    writeFileSync(join(root, "notes.md"), "");
    writeFileSync(join(root, "archive.zip"), "");
    writeFileSync(join(root, "noextension"), "");

    const listing = await listPath({ path: root });
    expect(listing.entries.map((entry) => entry.name)).toEqual(["nested", "a.db", "b.sqlite", "c.sqlite3"]);
    expect(listing.entries[0]?.isDirectory).toBe(true);
    expect(listing.parentPath).not.toBeNull();
    expect(listing.truncated).toBe(false);
  });

  it("honours a custom extension filter and lists everything for an empty one", async () => {
    const root = scratch();
    writeFileSync(join(root, "a.db"), "");
    writeFileSync(join(root, "b.txt"), "");
    expect((await listPath({ path: root, extensions: ["txt"] })).entries.map((entry) => entry.name)).toEqual(["b.txt"]);
    expect((await listPath({ path: root, extensions: [] })).entries.map((entry) => entry.name)).toEqual(["a.db", "b.txt"]);
  });

  it("stays bounded and reports truncation in a huge directory", async () => {
    const root = scratch();
    for (let index = 0; index < 5100; index += 1) {
      writeFileSync(join(root, `file-${String(index).padStart(5, "0")}.db`), "");
    }
    const started = Date.now();
    const listing = await listPath({ path: root });
    const elapsed = Date.now() - started;
    expect(listing.truncated).toBe(true);
    expect(listing.entries.length).toBeLessThanOrEqual(500);
    expect(listing.entries.every((entry) => entry.name.endsWith(".db"))).toBe(true);
    // Stat-ing every entry used to take long enough to look hung; this catches a regression.
    expect(elapsed).toBeLessThan(5000);
  });

  it("refuses a path that is not a directory", async () => {
    const root = scratch();
    const file = join(root, "a.db");
    writeFileSync(file, "");
    await expect(listPath({ path: file })).rejects.toThrow(/not a directory/i);
  });

  it("skips hidden entries", async () => {
    const root = scratch();
    writeFileSync(join(root, ".hidden.db"), "");
    writeFileSync(join(root, "visible.db"), "");
    expect((await listPath({ path: root })).entries.map((entry) => entry.name)).toEqual(["visible.db"]);
  });
});
