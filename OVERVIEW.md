# SQLite Studio

Browse and edit SQLite databases inside Paseo. Open a database from the SQLite screen, or from a
file tab in the file viewer, and work with it the way a desktop database tool would: a schema tree,
a data grid, a structure report, a read-only SQL console, exports, and optional row editing.

The plugin reads databases on the daemon that owns them. A database on a remote machine is queried
on that machine and only the results travel to your client, so file size and location do not limit
what you can look at.

## Setup

Nothing to configure to browse. Open SQLite Studio from the sidebar, or run its command from the command
center, then pick a file with the path field or the built-in browser. The browser offers your recent
workspaces as starting points and lists directories plus files ending in `.db`, `.sqlite`, `.sqlite3`,
`.db3`, `.s3db`, or `.gpkg`. Paths opened before are listed under recents, and the last directory you
browsed is remembered per daemon. With more than one daemon connected, the panel names the host it is
browsing.

Two requirements are worth knowing:

- The daemon host needs Node 22.13 or newer, because the plugin uses Node's own SQLite module. The
  desktop app bundles a suitable runtime. A daemon installed through npm or Docker uses the Node on
  that machine, and the plugin says so plainly when the module is missing.
- Opening a database directly from a file tab needs Paseo 0.13.0 or later, which is released. On 0.12
  the plugin still works from its own screen, and the file viewer keeps its binary preview message.

## Reading databases

Databases open read-only. When another process holds a write lock, the plugin copies the file to a
snapshot in the daemon's temporary directory and reads the copy, with a warning shown in the header;
a snapshot can miss changes that were not yet checkpointed, and it is deleted when you close the
database. Files that are not SQLite databases, including encrypted databases, are reported as such
instead of failing obscurely.

The schema tree groups tables, views, virtual tables, indexes, and triggers, and nests the shadow
tables of a virtual table under it. Selecting an object shows its structure: columns with declared
type, nullability, defaults, primary key position, uniqueness, and generated columns, plus indexes,
foreign keys with their actions, and the original DDL.

Rows are paged rather than loaded whole, with sorting, a search across all columns, and per-column
filters. The exact row count is computed only when you ask for it, because counting a large table
takes as long as reading it. Long text and binary values arrive as previews; the full value is
fetched when you open a cell, and binary values are shown as base64.

The SQL console runs read-only statements against the open database and keeps your last statements as
history. Statements that can take a long time run as a job that reports progress and can be
cancelled; the console notes when a scan hit its time budget and more rows exist.

Exports write a file on the machine running the daemon, in CSV, TSV, JSON, JSONL, Markdown, SQL
insert statements, or HTML. An export covers the current filters and sort, refuses to replace an
existing file unless you allow it, and stops with a warning after five million rows.

## Editing rows

Editing is off by default. Enabling it for a database opens the file for writing and asks once per
path before doing so. With editing on, open a cell and choose Edit row, or click the pencil in the
row gutter; the form opens on the column you clicked. A row can be inserted, updated, or deleted.
Changes run immediately against the real file inside a transaction, there is no undo, and other
programs reading the file see them. Primary keys and row identities are used to target a single row,
and a statement that matches no row reports that instead of doing nothing quietly. A table with no
primary key and no accessible rowid cannot be edited, and the grid says so instead of guessing which
row you meant. Editing a snapshot copy is refused, and switching editing off closes the writable
handle.

## Prompt attachments

The SQLite attachment source in the composer attaches a table as context for an agent: the DDL, the
column list with keys and defaults, indexes, foreign keys, and a few sample rows, bounded to about
four kilobytes. It searches tables and views in the databases you opened recently, on the daemon that
owns them. The attached text becomes part of the prompt, so the schema and sample rows go to the
agent provider you selected, like anything else you type there.

## Data and permissions

The plugin runs unsandboxed as trusted code. Server code reads the database files you open, writes
snapshot copies to the daemon's temporary directory, and writes export files to the paths you choose.
It sends nothing anywhere else and contacts no external service. Settings are stored per daemon: the
recent database paths, the SQL history, the paths you allowed editing on, the page size, and the last
browsed directory. Editing state and history stay on the daemon, and removing the plugin removes
them.

Known limits: no schema changes (no `CREATE`, `ALTER`, or `DROP` from the interface), no import, no
multi-statement execution, and no write access from the SQL console. Encrypted databases and
non-SQLite files cannot be opened.
