import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import type { ComponentType } from "react";
import { sqliteAttachments } from "./shared/attachment";
import { SqliteFilePanel, type SqliteFilePanelProps } from "./client/file-panel";
import { SqliteScreen } from "./client/sqlite-screen";

const DATABASE_EXTENSIONS = ["db", "sqlite", "sqlite3", "db3", "s3db", "gpkg"];

interface FilePanelContribution {
  id: string;
  title: string;
  icon: string;
  files: { extensions: readonly string[]; filenames?: readonly string[] };
  Component: ComponentType<SqliteFilePanelProps>;
}

interface FilePanelCapableClient {
  addFilePanel?: (contribution: FilePanelContribution) => () => void;
}

function SqliteSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Database"
      active={currentScreen?.screenId === "sqlite"}
      onPress={() => openScreen({ screenId: "sqlite" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const cleanups: Array<() => void> = [
    client.addScreen({ id: "sqlite", title: "SQLite Studio", Component: SqliteScreen }),
    client.addSidebarHeaderItem({ id: "sqlite", title: "SQLite Studio", Component: SqliteSidebarItem }),
    client.addCommandCenterItem({
      id: "open-sqlite-database",
      title: "Open SQLite Studio",
      icon: "Database",
      keywords: ["sqlite", "studio", "database", "db", "table", "schema", "query"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: "sqlite" });
      },
    }),
    client.addAttachmentSource(sqliteAttachments),
  ];

  // File panels arrive with Paseo 0.13. Registering only when the host offers
  // them keeps the plugin usable on 0.12 and switches the file tab on later.
  const addFilePanel = (client as PluginClientContext & FilePanelCapableClient).addFilePanel;
  if (typeof addFilePanel === "function") {
    cleanups.push(
      addFilePanel.call(client, {
        id: "sqlite-viewer",
        title: "SQLite Studio",
        icon: "Database",
        files: { extensions: DATABASE_EXTENSIONS },
        Component: SqliteFilePanel,
      }),
    );
  }

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
