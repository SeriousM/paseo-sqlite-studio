import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  affinityOf,
  countRows,
  describeColumns,
  hasRowId,
  listForeignKeys,
  listIndexes,
  listObjects,
  objectKind,
  primaryKeyColumns,
} from "../server/schema";

const FIXTURE = `
  create table users(
    id integer primary key autoincrement,
    name text not null unique,
    email text,
    created_at text default current_timestamp
  );
  create unique index users_email_idx on users(email) where email is not null;
  create index users_lower_name on users(lower(name));
  create table orders(
    id integer primary key,
    user_id integer not null references users(id) on delete cascade on update restrict,
    total real check (total >= 0),
    note text
  );
  create view order_totals as select user_id, sum(total) as total from orders group by user_id;
  create trigger orders_touch after insert on orders begin update orders set note = coalesce(note, 'new') where id = new.id; end;
  create table metrics(
    key text primary key,
    value integer,
    doubled integer generated always as (value * 2) stored
  ) without rowid, strict;
  create table tickets(
    id integer primary key,
    subject text,
    body text,
    priority text default 'normal'
  );
  create virtual table tickets_fts using fts5(subject, body, content='tickets');
`;

const directories: string[] = [];
const databases: DatabaseSync[] = [];

function fixtureDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "paseo-sqlite-schema-"));
  directories.push(directory);
  const db = new DatabaseSync(join(directory, "fixture.db"));
  databases.push(db);
  db.exec(FIXTURE);
  db.exec("insert into users(name, email) values ('ada', 'ada@example.com'), ('grace', null)");
  db.exec("insert into orders(user_id, total) values (1, 12.5)");
  db.exec("insert into metrics(key, value) values ('a', 2)");
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

describe("affinityOf", () => {
  it("follows SQLite's declared-type rules", () => {
    expect(affinityOf("INTEGER")).toBe("integer");
    expect(affinityOf("BIGINT")).toBe("integer");
    expect(affinityOf("VARCHAR(20)")).toBe("text");
    expect(affinityOf("CLOB")).toBe("text");
    expect(affinityOf("BLOB")).toBe("blob");
    expect(affinityOf("")).toBe("blob");
    expect(affinityOf("DOUBLE PRECISION")).toBe("real");
    expect(affinityOf("DECIMAL(10,5)")).toBe("numeric");
  });
});

describe("listObjects", () => {
  it("classifies tables, views, indexes, triggers, virtual and shadow tables", () => {
    const db = fixtureDatabase();
    const objects = listObjects(db);
    const byName = new Map(objects.map((object) => [object.name, object]));

    expect(byName.get("users")?.kind).toBe("table");
    expect(byName.get("order_totals")?.kind).toBe("view");
    expect(byName.get("users_email_idx")?.kind).toBe("index");
    expect(byName.get("users_email_idx")?.parentName).toBe("users");
    expect(byName.get("orders_touch")?.kind).toBe("trigger");
    expect(byName.get("orders_touch")?.parentName).toBe("orders");
    expect(byName.get("tickets_fts")?.kind).toBe("virtual-table");
    expect(byName.get("tickets_fts_data")?.kind).toBe("shadow-table");
    expect(byName.get("tickets_fts_data")?.parentName).toBe("tickets_fts");
    db.close();
  });

  it("hides internal tables but keeps the sequence table", () => {
    const db = fixtureDatabase();
    const names = listObjects(db).map((object) => object.name);
    expect(names).not.toContain("sqlite_schema");
    expect(names).toContain("sqlite_sequence");
    db.close();
  });
});

describe("describeColumns", () => {
  it("reports primary keys, constraints, defaults, and unique columns", () => {
    const db = fixtureDatabase();
    const detail = describeColumns(db, "users");
    const byName = new Map(detail.columns.map((column) => [column.name, column]));
    expect(byName.get("id")?.primaryKeyPosition).toBe(1);
    expect(byName.get("id")?.unique).toBe(true);
    expect(byName.get("name")?.notNull).toBe(true);
    expect(byName.get("name")?.unique).toBe(true);
    // `users_email_idx` is partial, and a partial unique index does not make a column unique.
    expect(byName.get("email")?.unique).toBe(false);
    expect(byName.get("email")?.notNull).toBe(false);
    expect(byName.get("created_at")?.defaultValue).toBe("current_timestamp");
    expect(detail.withoutRowId).toBe(false);
    expect(detail.strict).toBe(false);
    db.close();
  });

  it("marks generated columns and reads WITHOUT ROWID and STRICT flags", () => {
    const db = fixtureDatabase();
    const detail = describeColumns(db, "metrics");
    const doubled = detail.columns.find((column) => column.name === "doubled");
    expect(doubled?.hidden).toBe("generated-stored");
    expect(doubled?.declaredType).toBe("INTEGER");
    expect(detail.withoutRowId).toBe(true);
    expect(detail.strict).toBe(true);
    expect(primaryKeyColumns(db, "metrics")).toEqual(["key"]);
    expect(hasRowId(db, "metrics")).toBe(false);
    db.close();
  });

  it("hides the virtual columns of an fts5 table", () => {
    const db = fixtureDatabase();
    const detail = describeColumns(db, "tickets_fts");
    const hidden = detail.columns.filter((column) => column.hidden !== "normal").map((column) => column.name);
    expect(hidden).toContain("tickets_fts");
    expect(detail.columns.some((column) => column.name === "subject" && column.hidden === "normal")).toBe(true);
    db.close();
  });
});

describe("indexes, foreign keys, and identity", () => {
  it("lists index origins, partial and expression columns", () => {
    const db = fixtureDatabase();
    const indexes = listIndexes(db, "users");
    const byName = new Map(indexes.map((index) => [index.name, index]));
    expect(byName.get("users_email_idx")?.unique).toBe(true);
    expect(byName.get("users_email_idx")?.partial).toBe(true);
    expect(byName.get("users_email_idx")?.origin).toBe("create-index");
    expect(byName.get("users_lower_name")?.columns).toEqual(["<expression>"]);
    db.close();
  });

  it("lists foreign keys with their actions", () => {
    const db = fixtureDatabase();
    const keys = listForeignKeys(db, "orders");
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      fromColumn: "user_id",
      toTable: "users",
      toColumn: "id",
      onDelete: "CASCADE",
      onUpdate: "RESTRICT",
    });
    db.close();
  });

  it("counts rows and identifies object kinds", () => {
    const db = fixtureDatabase();
    expect(countRows(db, "users")).toBe(2);
    expect(countRows(db, "order_totals")).toBe(1);
    expect(objectKind(db, "order_totals")).toBe("view");
    expect(objectKind(db, "metrics")).toBe("table");
    expect(objectKind(db, "tickets_fts")).toBe("virtual-table");
    expect(objectKind(db, "nope")).toBeNull();
    expect(hasRowId(db, "users")).toBe(true);
    db.close();
  });
});
