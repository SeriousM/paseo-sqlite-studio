import type { PluginServerContext } from "@getpaseo/plugin/server";
import { viewerSettings } from "./shared/settings";
import { SqliteEngine } from "./server/engine";
import {
  closeHandle,
  listPath,
  openPath,
  readCellOf,
  readObjectOf,
  readRowsOf,
  readSchemaOf,
  runQueryOf,
} from "./server/handlers";
import {
  closeDatabase,
  listDirectory,
  openDatabase,
  readCell,
  readObject,
  readRows,
  readSchema,
  runQuery,
} from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  const engine = new SqliteEngine();
  server.registerSettings(viewerSettings);

  server.handle(listDirectory, (input) => listPath(input));
  server.handle(openDatabase, (input) => openPath(engine, input));
  server.handle(closeDatabase, (input) => closeHandle(engine, input));
  server.handle(readSchema, (input) => readSchemaOf(engine, input));
  server.handle(readObject, (input) => readObjectOf(engine, input));
  server.handle(readRows, (input) => readRowsOf(engine, input));
  server.handle(readCell, (input) => readCellOf(engine, input));
  server.handle(runQuery, (input) => runQueryOf(engine, input));

  return () => {
    engine.dispose();
  };
}
