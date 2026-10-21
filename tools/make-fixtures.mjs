// Generates the scratch databases used for manual and visual checks.
// Usage: node tools/make-fixtures.mjs [outputDirectory]
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const output = resolve(process.argv[2] ?? "scratch");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const store = join(output, "store.db");
{
  const db = new DatabaseSync(store);
  db.exec(`
    create table customers(
      id integer primary key autoincrement,
      name text not null unique,
      email text,
      country text default 'AT',
      created_at text default current_timestamp,
      notes text
    );
    create unique index customers_email_idx on customers(email) where email is not null;
    create index customers_lower_name on customers(lower(name));

    create table orders(
      id integer primary key,
      customer_id integer not null references customers(id) on delete cascade on update restrict,
      status text not null default 'open' check (status in ('open', 'paid', 'shipped', 'cancelled')),
      total real not null,
      placed_at text not null,
      receipt blob,
      note text
    );
    create index orders_customer on orders(customer_id);
    create index orders_status on orders(status, placed_at desc);

    create view order_summary as
      select c.name as customer, count(o.id) as order_count, sum(o.total) as revenue
      from customers c join orders o on o.customer_id = c.id
      group by c.id;

    create trigger orders_audit after update of status on orders begin
      update orders set note = coalesce(note, '') || ' [status -> ' || new.status || ']' where id = new.id;
    end;

    create table metrics(
      key text primary key,
      value integer not null,
      doubled integer generated always as (value * 2) stored
    ) without rowid, strict;

    create table products(
      id integer primary key,
      sku text not null,
      title text not null,
      description text
    );
    create virtual table products_fts using fts5(sku, title, description, content='products');
  `);

  const customer = db.prepare("insert into customers(name, email, country, notes) values (?, ?, ?, ?)");
  const customerNames = ["Ada Lovelace", "Grace Hopper", "Alan Turing", "Barbara Liskov", "Edsger Dijkstra"];
  db.exec("begin");
  for (let index = 1; index <= 200; index += 1) {
    const name = `${customerNames[index % customerNames.length]} ${index}`;
    customer.run(name, index % 7 === 0 ? null : `person${index}@example.com`, index % 3 === 0 ? "DE" : "AT", null);
  }
  db.exec("commit");

  const order = db.prepare(
    "insert into orders(customer_id, status, total, placed_at, receipt, note) values (?, ?, ?, ?, ?, ?)",
  );
  const statuses = ["open", "paid", "shipped", "cancelled"];
  db.exec("begin");
  for (let index = 1; index <= 20000; index += 1) {
    order.run(
      1 + (index % 200),
      statuses[index % statuses.length],
      Math.round(((index % 997) + 0.5) * 100) / 100,
      `2026-0${1 + (index % 9)}-1${index % 10} 08:${String(index % 60).padStart(2, "0")}:00`,
      index % 500 === 0 ? new Uint8Array([0x25, 0x50, 0x44, 0x46, index % 256]) : null,
      null,
    );
  }
  db.exec("commit");

  db.prepare("insert into metrics(key, value) values (?, ?)").run("conversion", 42);
  const product = db.prepare("insert into products(sku, title, description) values (?, ?, ?)");
  product.run("SKU-1", "Mechanical keyboard", "A long description ".repeat(400));
  product.run("SKU-2", "Trackball", null);
  db.exec("insert into products_fts(products_fts) values ('rebuild')");

  db.exec("pragma user_version = 7");
  db.close();
}

const wal = join(output, "events.db");
{
  const db = new DatabaseSync(wal);
  db.exec("pragma journal_mode = wal");
  db.exec("create table events(id integer primary key, kind text, payload text)");
  const insert = db.prepare("insert into events(kind, payload) values (?, ?)");
  db.exec("begin");
  for (let index = 1; index <= 5000; index += 1) insert.run(`kind-${index % 12}`, `{"n":${index}}`);
  db.exec("commit");
  db.close();
}

writeFileSync(join(output, "not-a-database.db"), "This file is named .db but is plain text.\n");

const locked = join(output, "locked.db");
{
  const db = new DatabaseSync(locked);
  db.exec("create table jobs(id integer primary key, state text, worker text)");
  const insert = db.prepare("insert into jobs(state, worker) values (?, ?)");
  db.exec("begin");
  for (let index = 1; index <= 300; index += 1) insert.run(index % 2 === 0 ? "running" : "queued", `worker-${index % 8}`);
  db.exec("commit");
  db.close();
}

const big = join(output, "big.db");
{
  const db = new DatabaseSync(big);
  db.exec("create table rows(id integer primary key, label text, score integer, payload text)");
  const insert = db.prepare("insert into rows(label, score, payload) values (?, ?, ?)");
  db.exec("begin");
  for (let index = 1; index <= 200000; index += 1) {
    insert.run(`row ${index}`, index % 1000, "x".repeat(40));
  }
  db.exec("commit");
  db.close();
}

console.log(`fixtures written to ${output}`);
console.log("store.db 20000 orders, events.db WAL, big.db 200000 rows, locked.db for lock checks, not-a-database.db");
