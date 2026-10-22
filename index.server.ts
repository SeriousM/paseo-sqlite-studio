import type { PluginServerContext } from "@getpaseo/plugin/server";
import { searchSqliteObjects } from "./shared/attachment";
import { viewerSettings } from "./shared/settings";
import { searchAttachments } from "./server/attachments";
import { SqliteEngine } from "./server/engine";
import { JobRegistry } from "./server/jobs";
import {
  cancelJobOf,
  closeHandle,
  deleteRowIn,
  insertRowIn,
  listPath,
  openPath,
  readCellOf,
  readObjectOf,
  pollJobOf,
  readRowsOf,
  readSchemaOf,
  readStatsOf,
  setWriting,
  startJobOf,
  updateRowIn,
} from "./server/handlers";
import {
  cancelJob,
  closeDatabase,
  deleteRow,
  enableWriting,
  insertRow,
  listDirectory,
  openDatabase,
  readCell,
  readObject,
  pollJob,
  readRows,
  readSchema,
  readStats,
  startJob,
  updateRow,
} from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  const engine = new SqliteEngine();
  const jobs = new JobRegistry(engine);
  const settings = server.registerSettings(viewerSettings);

  server.handle(searchSqliteObjects, async ({ query }) => {
    const current = await settings.read();
    const recentPaths = current.status === "ready" ? current.values.recentPaths : [];
    return searchAttachments(engine, recentPaths, query);
  });

  server.handle(listDirectory, (input) => listPath(input));
  server.handle(openDatabase, (input) => openPath(engine, input));
  server.handle(closeDatabase, (input) => closeHandle(engine, input));
  server.handle(readSchema, (input) => readSchemaOf(engine, input));
  server.handle(readObject, (input) => readObjectOf(engine, input));
  server.handle(readRows, (input) => readRowsOf(engine, input));
  server.handle(readCell, (input) => readCellOf(engine, input));
  server.handle(readStats, (input) => readStatsOf(engine, input));
  server.handle(startJob, (input) => startJobOf(jobs, input));
  server.handle(pollJob, (input) => pollJobOf(jobs, input));
  server.handle(cancelJob, (input) => cancelJobOf(jobs, input));
  server.handle(enableWriting, (input) => setWriting(engine, input));
  server.handle(insertRow, (input) => insertRowIn(engine, input));
  server.handle(updateRow, (input) => updateRowIn(engine, input));
  server.handle(deleteRow, (input) => deleteRowIn(engine, input));

  return () => {
    jobs.dispose();
    engine.dispose();
  };
}
