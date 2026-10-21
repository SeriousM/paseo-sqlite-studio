import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { z } from "zod";
import type { databaseInfoSchema, sqliteOpenErrorSchema } from "../shared/contracts";

export type DatabaseInfo = z.infer<typeof databaseInfoSchema>;
export type OpenError = z.infer<typeof sqliteOpenErrorSchema>;

interface SqliteModule {
  DatabaseSync: new (
    path: string,
    options?: {
      readOnly?: boolean;
      timeout?: number;
      enableForeignKeyConstraints?: boolean;
      enableDoubleQuotedStringLiterals?: boolean;
      allowExtension?: boolean;
      open?: boolean;
    },
  ) => DatabaseSync;
}

/**
 * `node:sqlite` does not exist on daemons older than the Node 22 line. Probing
 * with `getBuiltinModule` keeps the rest of the plugin loadable, so the UI can
 * explain the missing runtime instead of the whole plugin failing to start.
 */
export const sqliteModule: SqliteModule | undefined = process.getBuiltinModule?.("node:sqlite") as
  | SqliteModule
  | undefined;

export function requireSqlite(): SqliteModule {
  if (!sqliteModule) {
    throw new Error(
      `This Paseo daemon runs Node ${process.version}, which has no node:sqlite module. Run the daemon on Node 22.13 or newer.`,
    );
  }
  return sqliteModule;
}

const SQLITE_HEADER = "SQLite format 3\0";
const SNAPSHOT_DIR = join(tmpdir(), "paseo-sqlite-snapshots");
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const MAX_HANDLES = 12;

export interface DatabaseEntry {
  handleId: string;
  /** False once the user turns on editing for this handle. */
  readOnly: boolean;
  /** Canonical path the user opened; the snapshot path, when present, is a copy of it. */
  path: string;
  snapshotPath: string | null;
  /** Registry key of the snapshot this handle shares, if any. */
  snapshotKey: string | null;
  db: DatabaseSync;
  sizeBytes: number;
  modifiedAt: number;
  warnings: string[];
  lastUsedAt: number;
}

export type OpenOutcome = { ok: true; entry: DatabaseEntry } | { ok: false; error: OpenError };

interface SqliteErrorLike {
  code?: unknown;
  errcode?: unknown;
  errstr?: unknown;
  message?: unknown;
}

export function classifySqliteError(error: unknown): OpenError {
  const like = (error ?? {}) as SqliteErrorLike;
  const message = typeof like.message === "string" ? like.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("database is locked") || lower.includes("database table is locked") || lower.includes("busy")) {
    return { code: "locked", message, canSnapshot: true };
  }
  if (lower.includes("not a database") || lower.includes("encrypted") || lower.includes("malformed")) {
    return { code: "not-a-database", message, canSnapshot: false };
  }
  if (lower.includes("permission denied") || lower.includes("access is denied") || lower.includes("eperm")) {
    return { code: "permission", message, canSnapshot: false };
  }
  if (lower.includes("no such file") || lower.includes("enoent") || lower.includes("unable to open")) {
    return { code: "not-found", message, canSnapshot: false };
  }
  return { code: "unknown", message, canSnapshot: false };
}

function readHeader(path: string): string | null {
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(16);
    const read = readSync(handle, buffer, 0, 16, 0);
    return read === 16 ? buffer.toString("latin1") : null;
  } finally {
    closeSync(handle);
  }
}

export function sqliteUri(path: string, parameters: Record<string, string>): string {
  const encoded = encodeURI(path.replace(/\\/g, "/")).replace(/\?/g, "%3F").replace(/#/g, "%23");
  const query = Object.entries(parameters)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return `file:${encoded}${query.length > 0 ? `?${query}` : ""}`;
}

export interface FileProbe {
  exists: boolean;
  sizeBytes: number;
  modifiedAt: number;
  isSqlite: boolean;
  header: string | null;
  hasWal: boolean;
  hasJournal: boolean;
  readable: boolean;
}

export function probeFile(path: string): FileProbe {
  const absolute = resolve(path);
  const stats = (() => {
    try {
      return statSync(absolute);
    } catch {
      return null;
    }
  })();
  if (!stats) {
    return {
      exists: false,
      sizeBytes: 0,
      modifiedAt: 0,
      isSqlite: false,
      header: null,
      hasWal: false,
      hasJournal: false,
      readable: false,
    };
  }
  if (!stats.isFile()) {
    return {
      exists: true,
      sizeBytes: 0,
      modifiedAt: stats.mtimeMs,
      isSqlite: false,
      header: null,
      hasWal: false,
      hasJournal: false,
      readable: false,
    };
  }
  let header: string | null = null;
  let readable = true;
  try {
    header = readHeader(absolute);
  } catch {
    readable = false;
  }
  return {
    exists: true,
    sizeBytes: stats.size,
    modifiedAt: stats.mtimeMs,
    isSqlite: header === SQLITE_HEADER,
    header,
    hasWal: existsSync(`${absolute}-wal`),
    hasJournal: existsSync(`${absolute}-journal`),
    readable,
  };
}

export function readDatabaseInfo(db: DatabaseSync): DatabaseInfo {
  const scalar = (sql: string): unknown => {
    const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
    return row ? Object.values(row)[0] : undefined;
  };
  const toNumber = (value: unknown): number =>
    typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : 0;
  const toText = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);
  return {
    sqliteVersion: toText(scalar("select sqlite_version()"), "unknown"),
    journalMode: toText(scalar("pragma journal_mode"), "unknown"),
    pageSize: toNumber(scalar("pragma page_size")),
    pageCount: toNumber(scalar("pragma page_count")),
    freelistCount: toNumber(scalar("pragma freelist_count")),
    encoding: toText(scalar("pragma encoding"), "unknown"),
    userVersion: toNumber(scalar("pragma user_version")),
    applicationId: toNumber(scalar("pragma application_id")),
    schemaVersion: toNumber(scalar("pragma schema_version")),
    autoVacuum: toNumber(scalar("pragma auto_vacuum")),
  };
}

export class SqliteEngine {
  readonly #entries = new Map<string, DatabaseEntry>();
  /**
   * Snapshots are shared: opening the same locked file twice reuses one copy, and
   * the copy is deleted only when its last handle closes.
   */
  readonly #snapshots = new Map<string, { path: string; users: Set<string> }>();
  readonly #sweeper: NodeJS.Timeout;

  constructor() {
    this.#sweeper = setInterval(() => this.#sweep(), SWEEP_INTERVAL_MS);
    this.#sweeper.unref();
  }

  async open(path: string, mode: "direct" | "snapshot" = "direct"): Promise<OpenOutcome> {
    const absolute = resolve(path);
    const probe = probeFile(absolute);
    if (!probe.exists) {
      return { ok: false, error: { code: "not-found", message: `No such file: ${absolute}`, canSnapshot: false } };
    }
    if (!probe.readable) {
      return {
        ok: false,
        error: { code: "permission", message: `Not a readable file: ${absolute}`, canSnapshot: false },
      };
    }
    if (!probe.isSqlite) {
      const detail =
        probe.header === null ? "the file is empty" : `the file header is ${JSON.stringify(probe.header.slice(0, 15))}`;
      return {
        ok: false,
        error: {
          code: "not-a-database",
          message: `${absolute} is not a SQLite database: ${detail}. Encrypted databases (SEE, SQLCipher) are not supported.`,
          canSnapshot: false,
        },
      };
    }

    const warnings: string[] = [];
    const handleId = createHash("sha256")
      .update(`${absolute}:${Date.now()}:${Math.random()}`)
      .digest("hex")
      .slice(0, 16);

    if (mode === "snapshot") {
      const snapshot = await this.#acquireSnapshot(absolute, handleId, warnings);
      if (!snapshot) {
        return {
          ok: false,
          error: {
            code: "unknown",
            message: `Could not copy ${absolute} to a snapshot. Check free disk space and permissions.`,
            canSnapshot: false,
          },
        };
      }
      const opened = this.#openSnapshot(snapshot.path, warnings);
      if (!opened.ok) {
        this.#releaseSnapshot(snapshot.key, handleId);
        return opened;
      }
      return this.#register(opened.db, handleId, absolute, snapshot.path, snapshot.key, probe, warnings);
    }

    const direct = this.#openDirect(absolute);
    if (direct.ok) return this.#register(direct.db, handleId, absolute, null, null, probe, warnings);

    if (direct.error.code !== "locked") return direct;

    // Another process holds a write lock: read a copy instead of failing.
    const snapshot = await this.#acquireSnapshot(absolute, handleId, warnings);
    if (!snapshot) return direct;
    const opened = this.#openSnapshot(snapshot.path, warnings);
    if (!opened.ok) {
      this.#releaseSnapshot(snapshot.key, handleId);
      return direct;
    }
    warnings.push("Another process holds this database. You are reading a snapshot copy of the file.");
    return this.#register(opened.db, handleId, absolute, snapshot.path, snapshot.key, probe, warnings);
  }

  /**
   * Switches one handle between read-only and writable. A snapshot copy stays
   * read-only: writing to a copy would silently discard the user's work.
   */
  setWritable(handleId: string, writable: boolean): { readOnly: boolean; warning: string | null } {
    const entry = this.get(handleId);
    if (writable && entry.snapshotPath !== null) {
      return {
        readOnly: true,
        warning: "This handle reads a snapshot copy. Reopen the file directly to edit it.",
      };
    }
    if (entry.readOnly === !writable) return { readOnly: entry.readOnly, warning: null };

    const { DatabaseSync } = requireSqlite();
    const path = entry.snapshotPath ?? entry.path;
    const replacement = writable
      ? new DatabaseSync(path, { timeout: 5000 })
      : new DatabaseSync(path, { readOnly: true, timeout: 750 });
    if (writable) replacement.exec("pragma busy_timeout = 5000");
    readDatabaseInfo(replacement);
    try {
      entry.db.close();
    } catch {
      // The old handle is being replaced either way.
    }
    entry.db = replacement;
    entry.readOnly = !writable;
    entry.lastUsedAt = Date.now();
    return { readOnly: entry.readOnly, warning: null };
  }

  /** Handles this engine currently holds; used by diagnostics and tests. */
  list(): DatabaseEntry[] {
    return [...this.#entries.values()];
  }

  get(handleId: string): DatabaseEntry {
    const entry = this.#entries.get(handleId);
    if (!entry) throw new Error("This database is no longer open. Reopen it and try again.");
    entry.lastUsedAt = Date.now();
    return entry;
  }

  close(handleId: string): boolean {
    const entry = this.#entries.get(handleId);
    if (!entry) return false;
    this.#entries.delete(handleId);
    try {
      entry.db.close();
    } catch {
      // Closing an already-closed handle is not worth reporting.
    }
    if (entry.snapshotKey) this.#releaseSnapshot(entry.snapshotKey, handleId);
    return true;
  }

  dispose(): void {
    clearInterval(this.#sweeper);
    for (const handleId of [...this.#entries.keys()]) this.close(handleId);
  }

  #register(
    db: DatabaseSync,
    handleId: string,
    path: string,
    snapshotPath: string | null,
    snapshotKey: string | null,
    probe: FileProbe,
    warnings: string[],
  ): OpenOutcome {
    const entry: DatabaseEntry = {
      handleId,
      readOnly: true,
      path,
      snapshotPath,
      snapshotKey,
      db,
      sizeBytes: probe.sizeBytes,
      modifiedAt: probe.modifiedAt,
      warnings,
      lastUsedAt: Date.now(),
    };
    this.#entries.set(handleId, entry);
    this.#evictIfNeeded(handleId);
    return { ok: true, entry };
  }

  #openDirect(path: string): { ok: true; db: DatabaseSync } | { ok: false; error: OpenError } {
    const { DatabaseSync } = requireSqlite();
    try {
      const db = new DatabaseSync(path, { readOnly: true, timeout: 750 });
      readDatabaseInfo(db);
      return { ok: true, db };
    } catch (error) {
      return { ok: false, error: classifySqliteError(error) };
    }
  }

  /**
   * A snapshot is a throwaway copy, so the freshest correct read wins: opening it
   * read-write with `query_only` lets SQLite recover a copied write-ahead log,
   * which a read-only open cannot do when the shared-memory file is missing.
   */
  #openSnapshot(path: string, warnings: string[]): { ok: true; db: DatabaseSync } | { ok: false; error: OpenError } {
    const { DatabaseSync } = requireSqlite();
    let lastError: OpenError = { code: "unknown", message: `Could not open the snapshot of ${path}`, canSnapshot: false };
    try {
      const db = new DatabaseSync(path, { timeout: 750 });
      db.exec("pragma query_only = on");
      readDatabaseInfo(db);
      return { ok: true, db };
    } catch (error) {
      lastError = classifySqliteError(error);
    }
    try {
      const db = new DatabaseSync(path, { readOnly: true, timeout: 750 });
      readDatabaseInfo(db);
      warnings.push("Snapshot opened read-only; newest uncheckpointed changes may be missing.");
      return { ok: true, db };
    } catch (error) {
      lastError = classifySqliteError(error);
    }
    try {
      const db = new DatabaseSync(sqliteUri(path, { immutable: "1" }), { readOnly: true, timeout: 750 });
      readDatabaseInfo(db);
      warnings.push("Snapshot opened in immutable mode; newest uncheckpointed changes may be missing.");
      return { ok: true, db };
    } catch (error) {
      lastError = classifySqliteError(error);
    }
    return { ok: false, error: lastError };
  }

  /**
   * Streams the copy instead of blocking on one syscall, so a multi-gigabyte file
   * does not freeze the plugin, and reuses a copy that is already open.
   */
  async #acquireSnapshot(
    path: string,
    handleId: string,
    warnings: string[],
  ): Promise<{ path: string; key: string } | null> {
    try {
      mkdirSync(SNAPSHOT_DIR, { recursive: true });
      const stats = statSync(path);
      const digest = createHash("sha256").update(path).digest("hex").slice(0, 12);
      const key = `${digest}.${Math.round(stats.mtimeMs)}.${stats.size}`;

      const existing = this.#snapshots.get(key);
      if (existing && existsSync(existing.path)) {
        existing.users.add(handleId);
        return { path: existing.path, key };
      }

      const target = join(SNAPSHOT_DIR, `${basename(path)}.${key}.db`);
      await pipeline(createReadStream(path), createWriteStream(target));
      for (const suffix of ["-wal", "-shm"] as const) {
        const sidecar = `${path}${suffix}`;
        if (!existsSync(sidecar)) continue;
        try {
          await pipeline(createReadStream(sidecar), createWriteStream(`${target}${suffix}`));
        } catch {
          warnings.push(`Could not copy ${basename(sidecar)}; the snapshot may miss the newest changes.`);
        }
      }
      this.#snapshots.set(key, { path: target, users: new Set([handleId]) });
      return { path: target, key };
    } catch (error) {
      warnings.push(`Snapshot copy failed: ${classifySqliteError(error).message}`);
      return null;
    }
  }

  /** Drops one handle's claim on a snapshot; the files go when the last one closes. */
  #releaseSnapshot(key: string, handleId: string): void {
    const snapshot = this.#snapshots.get(key);
    if (!snapshot) return;
    snapshot.users.delete(handleId);
    if (snapshot.users.size > 0) return;
    this.#snapshots.delete(key);
    this.#deleteSnapshotFiles(snapshot.path);
  }

  #deleteSnapshotFiles(snapshotPath: string): void {
    for (const suffix of ["", "-wal", "-shm", "-journal"] as const) {
      try {
        rmSync(`${snapshotPath}${suffix}`, { force: true });
      } catch {
        // A leftover file in the temp directory is harmless.
      }
    }
  }

  #sweep(): void {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    for (const [handleId, entry] of [...this.#entries]) {
      if (entry.lastUsedAt < cutoff) this.close(handleId);
    }
  }

  #evictIfNeeded(protectedHandle: string): void {
    while (this.#entries.size > MAX_HANDLES) {
      let oldest: DatabaseEntry | null = null;
      for (const entry of this.#entries.values()) {
        if (entry.handleId === protectedHandle) continue;
        if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) oldest = entry;
      }
      if (!oldest) return;
      this.close(oldest.handleId);
    }
  }
}
