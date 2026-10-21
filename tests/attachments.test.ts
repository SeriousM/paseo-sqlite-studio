import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { searchAttachments } from "../server/attachments";
import { SqliteEngine } from "../server/engine";

const directories: string[] = [];
const engines: SqliteEngine[] = [];

function fixture(): { engine: SqliteEngine; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "paseo-sqlite-attach-"));
  directories.push(directory);
  const path = join(directory, "shop.db");
  const db = new DatabaseSync(path);
  db.exec(`
    create table customers(id integer primary key, name text not null unique, email text);
    create table orders(
      id integer primary key,
      customer_id integer not null references customers(id) on delete cascade,
      total real not null,
      placed_at text
    );
    create index orders_customer on orders(customer_id);
    create view order_totals as select customer_id, sum(total) as total from orders group by customer_id;
    insert into customers values (1, 'ada', 'ada@example.com');
    insert into orders values (1, 1, 12.5, '2026-01-02'), (2, 1, 30.0, '2026-02-03');
  `);
  db.close();

  const engine = new SqliteEngine();
  engines.push(engine);
  return { engine, path };
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

describe("attachment search", () => {
  it("describes a matching table with schema, keys, and sample rows", () => {
    const { engine, path } = fixture();
    const { items } = searchAttachments(engine, [path], "orders");
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item?.title).toBe("orders");
    expect(item?.identifier).toBe("shop.db › orders");
    expect(item?.resourceType).toBe("sqlite-object");
    expect(item?.url.startsWith("file://")).toBe(true);
    expect(item?.text).toContain("CREATE TABLE orders");
    expect(item?.text).toContain("| column | type | nullable | key |");
    expect(item?.text).toContain("Foreign keys:");
    expect(item?.text).toContain("customer_id -> customers.id");
    expect(item?.text).toContain("Sample rows");
    expect(item?.text).toContain("12.5");
    expect(item?.text).toContain("2026-01-02");
  });

  it("matches views too", () => {
    const { engine, path } = fixture();
    const { items } = searchAttachments(engine, [path], "order_totals");
    expect(items[0]?.text).toContain("### order_totals (view)");
  });

  it("returns objects for an empty query and caps the list", () => {
    const { engine, path } = fixture();
    const { items } = searchAttachments(engine, [path], "");
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.length).toBeLessThanOrEqual(8);
  });

  it("skips unreadable or missing recent paths without failing", () => {
    const { engine, path } = fixture();
    const missing = join(path, "..", "gone.db");
    const { items } = searchAttachments(engine, [missing, path], "customers");
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("customers");
  });

  it("ignores a file that is not a database", () => {
    const { engine, path } = fixture();
    const fake = join(path, "..", "fake.db");
    writeFileSync(fake, "not sqlite at all");
    const { items } = searchAttachments(engine, [fake], "");
    expect(items).toHaveLength(0);
  });

  it("leaves no handles open behind it", () => {
    const { engine, path } = fixture();
    searchAttachments(engine, [path], "orders");
    expect(engine.list()).toHaveLength(0);
  });

  it("keeps a snapshot of a wide table inside the prompt budget", () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-sqlite-attach-wide-"));
    directories.push(directory);
    const path = join(directory, "wide.db");
    const db = new DatabaseSync(path);
    const columns = Array.from({ length: 60 }, (_entry, index) => `column_${index} text`).join(", ");
    db.exec(`create table wide(${columns})`);
    db.exec(`insert into wide values (${Array.from({ length: 60 }, () => "'value'").join(", ")})`);
    db.close();

    const engine = new SqliteEngine();
    engines.push(engine);
    const { items } = searchAttachments(engine, [path], "wide");
    expect(items[0]?.text.length).toBeLessThanOrEqual(4100);
  });
});
