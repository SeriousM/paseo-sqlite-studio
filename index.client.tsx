import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { SqliteFilePanel } from "./client/file-panel";
import { SqliteScreen } from "./client/sqlite-screen";
import { sqliteAttachments } from "./shared/attachment";
import { DATABASE_EXTENSIONS } from "./shared/databases";

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

  // File panels arrive with Paseo 0.13. The runtime check keeps this plugin usable
  // on 0.12 hosts, where the method does not exist yet.
  if (typeof client.addFilePanel === "function") {
    cleanups.push(
      client.addFilePanel({
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
