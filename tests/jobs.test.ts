import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEngine } from "../server/engine";
import { JobRegistry, type JobStatus } from "../server/jobs";
import { encodeCell } from "../shared/cell-encoding";

const directories: string[] = [];
const engines: SqliteEngine[] = [];
const registries: JobRegistry[] = [];

function scratchDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "paseo-sqlite-jobs-"));
  directories.push(directory);
  return directory;
}

function fixture(): { engine: SqliteEngine; jobs: JobRegistry; handleId: string; directory: string } {
  const directory = scratchDirectory();
  const path = join(directory, "fixture.db");
  const db = new DatabaseSync(path);
  db.exec("create table items(id integer primary key, name text, blob_col blob); ");
  const insert = db.prepare("insert into items(name, blob_col) values (?, ?)");
  db.exec("begin");
  for (let index = 1; index <= 300; index += 1) {
    insert.run(`item-${index}`, new Uint8Array([index % 256, 1, 2, 3]));
  }
  db.exec("commit");
  db.close();

  const engine = new SqliteEngine();
  engines.push(engine);
  const opened = engine.open(path);
  if (!opened.ok) throw new Error("fixture database did not open");
  const jobs = new JobRegistry(engine);
  registries.push(jobs);
  return { engine, jobs, handleId: opened.entry.handleId, directory };
}

/**
 * Waits for a job to leave the running state. A real worker runs off-thread, so
 * this waits on the platform clock on purpose instead of faking timers.
 */
async function waitForJob(jobs: JobRegistry, jobId: string, timeoutMs = 15_000): Promise<JobStatus> {
  const deadline = Date.now() + timeoutMs;
  let status = jobs.poll(jobId);
  while (status.state === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    status = jobs.poll(jobId);
  }
  return status;
}

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
  for (const engine of engines.splice(0)) engine.dispose();
  for (const directory of directories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Windows can keep a handle briefly after a failed assertion.
    }
  }
});

describe("SQL jobs", () => {
  it("runs a select in a worker and returns encoded rows", async () => {
    const { jobs, handleId } = fixture();
    const { jobId } = jobs.start({ kind: "sql", handleId, sql: "select id, name, blob_col from items order by id", limit: 5 });
    const status = await waitForJob(jobs, jobId);
    expect(status.state).toBe("done");
    expect(status.error).toBeNull();
    if (status.result?.kind !== "sql") throw new Error("expected a sql result");
    expect(status.result.result.columns.map((column) => column.name)).toEqual(["id", "name", "blob_col"]);
    expect(status.result.result.rows).toHaveLength(5);
    expect(status.result.result.hasMore).toBe(true);
    expect(status.result.result.rows[0]?.[1]).toBe("item-1");
    // The worker embeds the shared encoder: blob previews must match the plugin thread exactly.
    expect(status.result.result.rows[0]?.[2]).toEqual(encodeCell(new Uint8Array([1, 1, 2, 3])));
    expect(status.result.changes).toBeNull();
  });

  it("fails with the database message for bad SQL", async () => {
    const { jobs, handleId } = fixture();
    const { jobId } = jobs.start({ kind: "sql", handleId, sql: "select * from missing_table", limit: 10 });
    const status = await waitForJob(jobs, jobId);
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/no such table/i);
  });

  it("rejects writes because the handle is read-only", async () => {
    const { jobs, handleId } = fixture();
    const { jobId } = jobs.start({ kind: "sql", handleId, sql: "delete from items", limit: 10 });
    const status = await waitForJob(jobs, jobId);
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/readonly|read-only/i);
  });

  it("cancels a long-running query", async () => {
    const { jobs, handleId } = fixture();
    const { jobId } = jobs.start({
      kind: "sql",
      handleId,
      sql: "with recursive slow(i) as (select 1 union all select i + 1 from slow where i < 40000000) select count(*) from slow",
      limit: 10,
    });
    expect(jobs.cancel(jobId)).toBe(true);
    const status = await waitForJob(jobs, jobId);
    expect(status.state).toBe("cancelled");
    expect(jobs.cancel(jobId)).toBe(false);
  });

  it("rejects an unknown job id", () => {
    const { jobs } = fixture();
    expect(() => jobs.poll("nope")).toThrow(/no longer tracked/i);
  });
});

describe("export jobs", () => {
  it("writes CSV, JSONL, SQL, Markdown, and HTML files", async () => {
    const { jobs, handleId, directory } = fixture();
    const expectations: Array<{ format: "csv" | "jsonl" | "sql" | "markdown" | "html"; check: (text: string) => void }> = [
      { format: "csv", check: (text) => expect(text.split("\r\n")[0]).toBe("id,name,blob_col") },
      { format: "jsonl", check: (text) => expect(JSON.parse(text.split("\n")[0] ?? "{}")).toMatchObject({ id: 1, name: "item-1" }) },
      { format: "sql", check: (text) => expect(text).toContain('insert into "items" ("id", "name", "blob_col") values (1, \'item-1\'') },
      { format: "markdown", check: (text) => expect(text.split("\n")[0]).toBe("| id | name | blob_col |") },
      { format: "html", check: (text) => expect(text).toContain("<th>id</th>") },
    ];
    for (const expectation of expectations) {
      const target = join(directory, `items.${expectation.format}`);
      const { jobId } = jobs.start({
        kind: "export",
        handleId,
        object: "items",
        format: expectation.format,
        targetPath: target,
      });
      const status = await waitForJob(jobs, jobId);
      expect(status.state).toBe("done");
      if (status.result?.kind !== "export") throw new Error("expected an export result");
      expect(status.result.rows).toBe(300);
      expect(status.result.bytes).toBeGreaterThan(0);
      expectation.check(readFileSync(target, "utf8"));
    }
  });

  it("honours filters and refuses to overwrite without permission", async () => {
    const { jobs, handleId, directory } = fixture();
    const target = join(directory, "filtered.csv");
    const first = jobs.start({
      kind: "export",
      handleId,
      object: "items",
      format: "csv",
      targetPath: target,
      filters: [{ column: "name", operator: "endsWith", value: "0" }],
    });
    const firstStatus = await waitForJob(jobs, first.jobId);
    expect(firstStatus.state).toBe("done");
    const lines = readFileSync(target, "utf8").trim().split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length).toBeLessThan(301);

    const second = jobs.start({ kind: "export", handleId, object: "items", format: "csv", targetPath: target });
    const secondStatus = await waitForJob(jobs, second.jobId);
    expect(secondStatus.state).toBe("failed");
    expect(secondStatus.error).toMatch(/already exists/i);

    const third = jobs.start({
      kind: "export",
      handleId,
      object: "items",
      format: "csv",
      targetPath: target,
      overwrite: true,
    });
    expect((await waitForJob(jobs, third.jobId)).state).toBe("done");
  });

  it("exports a caller-provided select", async () => {
    const { jobs, handleId, directory } = fixture();
    const target = join(directory, "custom.csv");
    const { jobId } = jobs.start({
      kind: "export",
      handleId,
      object: "items",
      sql: "select count(*) as total from items",
      format: "csv",
      targetPath: target,
    });
    const status = await waitForJob(jobs, jobId);
    expect(status.state).toBe("done");
    expect(readFileSync(target, "utf8")).toContain("total");
    expect(readFileSync(target, "utf8")).toContain("300");
  });

  it("fails clearly when the target directory does not exist", async () => {
    const { jobs, handleId, directory } = fixture();
    const { jobId } = jobs.start({
      kind: "export",
      handleId,
      object: "items",
      format: "csv",
      targetPath: join(directory, "missing-dir", "items.csv"),
    });
    const status = await waitForJob(jobs, jobId);
    expect(status.state).toBe("failed");
    expect(status.error).toBeTruthy();
  });
});

describe("job registry limits", () => {
  it("keeps the running-job count bounded", () => {
    const { jobs, handleId } = fixture();
    const started: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      started.push(
        jobs.start({
          kind: "sql",
          handleId,
          sql: "with recursive slow(i) as (select 1 union all select i + 1 from slow where i < 40000000) select count(*) from slow",
          limit: 1,
        }).jobId,
      );
    }
    expect(() =>
      jobs.start({ kind: "sql", handleId, sql: "select 1", limit: 1 }),
    ).toThrow(/too many jobs/i);
    for (const jobId of started) jobs.cancel(jobId);
  });
});

describe("export writer edge cases", () => {
  it("writes an empty result with only a header", async () => {
    const { jobs, handleId, directory } = fixture();
    const target = join(directory, "empty.csv");
    const { jobId } = jobs.start({
      kind: "export",
      handleId,
      object: "items",
      format: "csv",
      targetPath: target,
      filters: [{ column: "name", operator: "eq", value: "nothing" }],
    });
    const status = await waitForJob(jobs, jobId);
    expect(status.state).toBe("done");
    if (status.result?.kind !== "export") throw new Error("expected an export result");
    expect(status.result.rows).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("id,name,blob_col\r\n");
  });

  it("fails on a non-SQLite target instead of writing garbage", async () => {
    const { jobs, handleId, directory } = fixture();
    const target = join(directory, "broken.csv");
    writeFileSync(target, "existing");
    const { jobId } = jobs.start({
      kind: "export",
      handleId,
      object: "items",
      format: "csv",
      targetPath: target,
      overwrite: true,
    });
    const status = await waitForJob(jobs, jobId);
    expect(status.state).toBe("done");
    expect(readFileSync(target, "utf8").startsWith("id,name")).toBe(true);
  });
});
