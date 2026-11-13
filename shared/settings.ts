import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const SIDEBAR_WIDTH_MIN = 80;
export const SIDEBAR_WIDTH_MAX = 640;
export const SIDEBAR_WIDTH_DEFAULT = 280;

/**
 * Host-scoped viewer preferences. Recents are per daemon because paths only
 * mean something on the machine that owns them.
 */
export const viewerSettings = defineSettings({
  id: "viewer",
  scope: "host",
  version: 1,
  schema: z.object({
    recentPaths: z.array(z.string()).default([]),
    pageSize: z.number().int().min(25).max(1000).default(200),
    /** Remember the last directory used by the open panel. */
    lastDirectory: z.string().default(""),
    /** Skip the confirmation when a locked database falls back to a snapshot. */
    snapshotWithoutAsking: z.boolean().default(false),
    /** Statements typed in the SQL console, newest first. */
    sqlHistory: z.array(z.string()).default([]),
    /** Column widths the user picked, keyed by "object.column". */
    columnWidths: z.record(z.string(), z.number().int().min(60).max(640)).default({}),
    /** Width of the schema-tree sidebar; the splitter clamps to the same range. */
    sidebarWidth: z.number().int().min(SIDEBAR_WIDTH_MIN).max(SIDEBAR_WIDTH_MAX).default(SIDEBAR_WIDTH_DEFAULT),
    /** Named statements the user saved, newest first. */
    savedQueries: z
      .array(z.object({ name: z.string(), sql: z.string() }))
      .default([]),
    /** Databases the user allowed editing on, by path. */
    writablePaths: z.array(z.string()).default([]),
  }),
});
