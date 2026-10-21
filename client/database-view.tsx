import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useObjectDetail, useSchema, type OpenedDatabase } from "./api";
import { CellDetail } from "./cell-detail";
import { DataGrid, type CellTarget } from "./data-grid";
import { SchemaTree } from "./schema-tree";
import { StructureView } from "./structure-view";
import { formatBytesForHumans } from "./format";
import type { ViewerHost } from "./types";

export interface DatabaseViewProps extends ViewerHost {
  handleId: string;
  database: OpenedDatabase;
  pageSize: number;
  onClose?: () => void;
}

type Tab = "data" | "structure";

export function DatabaseView({ theme, layout, handleId, database, pageSize, onClose }: DatabaseViewProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("data");
  // Compact clients toggle between the object list and the content; they start on the list.
  const [treeVisible, setTreeVisible] = useState(layout.compact);
  const [cell, setCell] = useState<CellTarget | null>(null);

  const schema = useSchema(handleId);
  const detail = useObjectDetail(handleId, selected);
  const objects = schema.data?.objects ?? [];
  const selectedDetail = detail.data ?? null;

  const styles = useMemo(
    () => ({
      root: { flex: 1, backgroundColor: theme.colors.surface0 },
      header: {
        paddingHorizontal: layout.compact ? 10 : 14,
        paddingVertical: 8,
        gap: 6,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      titleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const, flex: 1 },
      subtitle: { color: theme.colors.foregroundMuted, fontSize: 11 },
      badgeRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      badge: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        color: theme.colors.foregroundMuted,
        fontSize: 10,
      },
      badgeWarning: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.statusWarning,
        color: theme.colors.statusWarning,
        fontSize: 10,
      },
      body: { flex: 1, flexDirection: "row" as const },
      tree: {
        width: layout.compact ? undefined : 280,
        flex: layout.compact ? 1 : undefined,
        borderRightWidth: layout.compact ? 0 : 1,
        borderRightColor: theme.colors.border,
      },
      content: { flex: 1 },
      tabs: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: layout.compact ? 10 : 14,
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      tab: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
      tabActive: { backgroundColor: theme.colors.accent },
      tabText: { color: theme.colors.foreground, fontSize: 12 },
      tabTextActive: { color: theme.colors.accentForeground, fontSize: 12 },
      button: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      buttonText: { color: theme.colors.foreground, fontSize: 12 },
      hint: { padding: layout.compact ? 16 : 24, color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { padding: layout.compact ? 16 : 24, color: theme.colors.statusDanger, fontSize: 13 },
    }),
    [theme, layout.compact],
  );

  const fileName = database.path.split(/[\\/]/).pop() ?? database.path;
  // Desktop shows the object list beside the content; compact toggles between them.
  const showTree = layout.compact ? treeVisible : true;
  const showContent = layout.compact ? !treeVisible : true;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={styles.title}>
            {fileName}
          </Text>
          {layout.compact ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Show objects"
              style={styles.button}
              onPress={() => setTreeVisible(!treeVisible)}
            >
              <Text style={styles.buttonText}>{treeVisible ? "Data" : "Objects"}</Text>
            </Pressable>
          ) : null}
          {onClose ? (
            <Pressable accessibilityRole="button" style={styles.button} onPress={onClose}>
              <Text style={styles.buttonText}>Close</Text>
            </Pressable>
          ) : null}
        </View>
        <Text numberOfLines={1} style={styles.subtitle}>
          {database.path} · {formatBytesForHumans(database.sizeBytes)} · SQLite {database.info.sqliteVersion}
        </Text>
        <View style={styles.badgeRow}>
          <Text style={styles.badge}>read-only</Text>
          <Text style={styles.badge}>{database.info.journalMode}</Text>
          <Text style={styles.badge}>{database.info.pageSize} B pages</Text>
          {database.snapshotPath !== null ? <Text style={styles.badgeWarning}>snapshot copy</Text> : null}
          {database.warnings.map((warning) => (
            <Text key={warning} style={styles.badgeWarning}>
              {warning}
            </Text>
          ))}
        </View>
      </View>

      <View style={styles.body}>
        {showTree ? (
          <View style={styles.tree}>
            <SchemaTree
              theme={theme}
              layout={layout}
              objects={objects}
              selected={selected}
              loading={schema.isPending}
              error={schema.error === null ? null : String(schema.error.message)}
              onSelect={(name) => {
                setSelected(name);
                if (layout.compact) setTreeVisible(false);
              }}
            />
          </View>
        ) : null}
        {showContent ? (
          <View style={styles.content}>
            <View style={styles.tabs}>
              <Pressable
                accessibilityRole="button"
                style={[styles.tab, tab === "data" ? styles.tabActive : null]}
                onPress={() => setTab("data")}
              >
                <Text style={tab === "data" ? styles.tabTextActive : styles.tabText}>Data</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={[styles.tab, tab === "structure" ? styles.tabActive : null]}
                onPress={() => setTab("structure")}
              >
                <Text style={tab === "structure" ? styles.tabTextActive : styles.tabText}>Structure</Text>
              </Pressable>
              <Text numberOfLines={1} style={styles.subtitle}>
                {selected ?? "no object selected"}
              </Text>
            </View>

            {selected === null ? (
              <Text style={styles.hint}>Pick a table, view, or index on the left to inspect it.</Text>
            ) : tab === "structure" ? (
              <StructureView
                theme={theme}
                layout={layout}
                detail={selectedDetail}
                loading={detail.isPending}
                error={detail.error === null ? null : String(detail.error.message)}
              />
            ) : selectedDetail && selectedDetail.kind !== "table" && selectedDetail.kind !== "view" && selectedDetail.kind !== "virtual-table" && selectedDetail.kind !== "shadow-table" ? (
              <Text style={styles.hint}>Indexes and triggers have no rows. Open the Structure tab.</Text>
            ) : detail.isError ? (
              <Text style={styles.error}>{String(detail.error.message)}</Text>
            ) : (
              <DataGrid
                theme={theme}
                layout={layout}
                handleId={handleId}
                object={selected}
                columns={selectedDetail?.columns ?? []}
                pageSize={pageSize}
                onOpenCell={(target: CellTarget) => setCell(target)}
              />
            )}
          </View>
        ) : null}
      </View>

      <CellDetail
        theme={theme}
        layout={layout}
        visible={cell !== null}
        handleId={handleId}
        object={selected ?? ""}
        column={cell?.column ?? ""}
        rowKey={cell?.key ?? null}
        preview={cell?.cell ?? null}
        onClose={() => setCell(null)}
      />
    </View>
  );
}
