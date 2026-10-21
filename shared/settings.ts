import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

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
  }),
});
