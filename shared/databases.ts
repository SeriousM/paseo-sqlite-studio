/**
 * File endings treated as SQLite databases. Shared so the file browser, the file
 * panel registration, and the UI note describe the same set.
 */
export const DATABASE_EXTENSIONS = ["db", "sqlite", "sqlite3", "db3", "s3db", "gpkg", "sqlite2"] as const;

export function databaseExtensionsLabel(): string {
  return DATABASE_EXTENSIONS.map((extension) => `.${extension}`).join(", ");
}
