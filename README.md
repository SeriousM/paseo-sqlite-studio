# SQLite Studio for Paseo

Open a SQLite database inside Paseo: browse its structure, page through rows, run SQL, and edit rows
when you turn editing on. The database is read where it lives, so this works the same on a local
daemon and on a remote one.

## What it does

- Opens `.db`, `.sqlite`, `.sqlite3`, `.db3`, `.s3db`, and `.gpkg` files from its screen, with a
  path field, a server-side file browser that starts from your recent workspaces, and a recents list.
- Shows the schema as a tree: tables, views, virtual tables with their shadow tables nested, indexes,
  and triggers, with counts per group.
- Reports per-object structure: columns with declared type, affinity, `NOT NULL`, default, primary key
  position, uniqueness, and generated or hidden columns; indexes with their origin and columns;
  foreign keys with their update and delete actions; and the original DDL.
- Pages through rows in a virtualized grid with sorting, a global search, and per-column filters
  (`=`, `≠`, `<`, `≤`, `>`, `≥`, `contains`, `not contains`, `starts with`, `ends with`, `is empty`,
  `is not empty`, `is NULL`, `is not NULL`).
- Shows a full cell value on demand: long text in a scrollable block, binary data as base64 with its
  size, and `NULL` distinguished from an empty string.
- Runs read-only SQL from a console with statement history, and exports a result set to CSV, TSV,
  JSON, JSONL, Markdown, SQL inserts, or HTML.
- Edits rows (insert, update, delete) after you explicitly enable editing for that database.
- Attaches a table's schema, keys, and sample rows to a composer prompt through the SQLite
  attachment source.

## How it works

Paseo plugins run in two places: the daemon and the app. This plugin uses `node:sqlite` on the daemon
for every database operation, so nothing but query results crosses the wire. That is why a multi
gigabyte file opens instantly, why a database on a remote machine works as well as a local one, and
why no dependency beyond Node's own SQLite module is needed.

Databases are opened read-only by default. When another process holds a write lock, the plugin
copies the file to a snapshot in the daemon's temporary directory and reads that copy instead, with a
warning in the header. Editing is off until you enable it for a specific file, and the change is
remembered per path.

Long or unpredictable statements run in a worker thread with a job you can cancel, so a slow query
does not freeze the rest of the plugin. Cell values, row keys, and the row budget are shared between
the plugin thread and the worker by embedding the same encoder into both.

## Install

```sh
paseo plugin add git:SeriousM/paseo-sqlite-studio
```

Or from a local checkout:

```sh
paseo plugin install /absolute/path/to/this/repository
```

Plugins are trusted, unsandboxed code. Server code runs with the daemon user's access to the machine,
including its files, so review the source before installing.

## Requirements

- Paseo 0.12.0 or later.
- The daemon host runs Node 22.13 or newer (the desktop app bundles a suitable runtime; a daemon
  installed through npm or Docker needs its own Node). The plugin reports a clear message when the
  runtime has no `node:sqlite`.
- Opening a database from the file viewer tab needs Paseo 0.13.0 or later (released 2026-10-24). On
  0.12 the plugin opens from its own screen and the file viewer keeps showing its binary preview
  message. The panel registration is feature-detected, so one build covers both releases.
- Development typechecks against `@getpaseo/plugin` 0.13.0 to get the file-panel types, while the
  runtime stays compatible with 0.12 hosts.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
node tools/make-fixtures.mjs scratch   # sample databases for manual checks
paseo plugin reload paseo-sqlite-studio
```

`scratch/` holds generated databases and screenshots and is not committed.

## Layout

```
index.client.tsx     app entry: screen, sidebar item, command center, file panel, attachment source
index.server.ts      daemon entry: RPC handlers, jobs, settings
client/              React Native surfaces
server/              engine, introspection, queries, exports, mutations, jobs
shared/              Zod contracts, value encoding, settings, attachment definition
tests/               engine, schema, query, job, mutation, and attachment tests
```

## License

MIT
