import { defineAttachmentSource, defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Turns a table into prompt context: the schema, its keys, and a few sample rows.
 * The search runs on the daemon, next to the database, so a large file never
 * travels just to describe one table.
 */
export const searchSqliteObjects = defineRpc({
  name: "sqlite.attach.search",
  input: z.object({ query: z.string() }),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        identifier: z.string(),
        title: z.string(),
        subtitle: z.string().optional(),
        url: z.string(),
        text: z.string(),
        resourceType: z.string(),
      }),
    ),
  }),
});

export const sqliteAttachments = defineAttachmentSource({
  id: "sqlite",
  title: "SQLite table",
  icon: "Database",
  pickerTitle: "Attach a SQLite table",
  searchPlaceholder: "Search tables in recently opened databases",
  search: searchSqliteObjects,
});
