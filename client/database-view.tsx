import { useSettings } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { viewerSettings } from "../shared/settings";
import {
  useObjectDetail,
  useSchema,
  useSetWriting,
  type Cell,
  type ColumnMeta,
  type Filter,
  type KeyValue,
  type Sort,
  type OpenedDatabase,
} from "./api";
import { CellDetail } from "./cell-detail";
import { DataGrid, type CellTarget, type GridColumn } from "./data-grid";
import { ExportDialog } from "./export-dialog";
import { RowEditor } from "./row-editor";
import { SchemaTree } from "./schema-tree";
import { SqlConsole } from "./sql-console";
import { StructureView } from "./structure-view";
import { formatBytesForHumans } from "./format";
import type { ViewerHost } from "./types";

export interface DatabaseViewProps extends ViewerHost {
  handleId: string;
  database: OpenedDatabase;
  pageSize: number;
  onClose?: () => void;
}

type Tab = "data" | "structure" | "sql";

interface EditorTarget {
  mode: "insert" | "edit";
  key: KeyValue[] | null;
  values: Cell[] | null;
}

function directoryOf(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator > 0 ? path.slice(0, separator) : path;
}

export function DatabaseView({ theme, layout, handleId, database, pageSize, onClose }: DatabaseViewProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("data");
  // Compact clients toggle between the object list and the content; they start on the list.
  const [treeVisible, setTreeVisible] = useState(layout.compact);
  const [cell, setCell] = useState<CellTarget | null>(null);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort[]>([]);
  const [writable, setWritable] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const schema = useSchema(handleId);
  const detail = useObjectDetail(handleId, selected);
  const setWriting = useSetWriting();
  const settings = useSettings(viewerSettings);

  const objects = schema.data?.objects ?? [];
  const selectedDetail = detail.data ?? null;
  const visibleColumns: GridColumn[] = useMemo(
    () => (selectedDetail?.columns ?? []).filter((column) => column.hidden === "normal"),
    [selectedDetail],
  );

  const applyWriting = useCallback(
    (enabled: boolean) => {
      setWriting.mutate(
        { handleId, enabled },
        {
          onSuccess: (result) => {
            setWritable(!result.readOnly);
            if (settings.status !== "ready") return;
            const paths = result.readOnly
              ? settings.values.writablePaths.filter((entry) => entry !== database.path)
              : [...new Set([...settings.values.writablePaths, database.path])];
            void settings.save({ ...settings.values, writablePaths: paths }, settings.revision);
          },
        },
      );
    },
    [database.path, handleId, setWriting, settings],
  );

  function toggleWriting() {
    if (writable) {
      applyWriting(false);
      return;
    }
    const remembered = settings.status === "ready" && settings.values.writablePaths.includes(database.path);
    if (remembered) applyWriting(true);
    else setConsentOpen(true);
  }

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
      badgeDanger: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.statusDanger,
        color: theme.colors.statusDanger,
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
      buttonDanger: { borderColor: theme.colors.statusDanger },
      buttonText: { color: theme.colors.foreground, fontSize: 12 },
      buttonTextDanger: { color: theme.colors.statusDanger, fontSize: 12 },
      hint: { padding: layout.compact ? 16 : 24, color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { padding: layout.compact ? 16 : 24, color: theme.colors.statusDanger, fontSize: 13 },
      consent: { gap: 12 },
      consentTitle: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
      consentBody: { color: theme.colors.foregroundMuted, fontSize: 13 },
      consentDanger: { color: theme.colors.statusDanger, fontSize: 13 },
      consentActions: { flexDirection: "row" as const, gap: 8, justifyContent: "flex-end" as const },
    }),
    [theme, layout.compact],
  );

  const fileName = database.path.split(/[\\/]/).pop() ?? database.path;
  const showTree = layout.compact ? treeVisible : true;
  const showContent = layout.compact ? !treeVisible : true;
  const isData = selectedDetail?.kind === "table" || selectedDetail?.kind === "view" || selectedDetail?.kind === "virtual-table" || selectedDetail?.kind === "shadow-table";

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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={writable ? "Turn editing off" : "Turn editing on"}
            style={[styles.button, writable ? styles.buttonDanger : null]}
            onPress={toggleWriting}
          >
            <Text style={writable ? styles.buttonTextDanger : styles.buttonText}>
              {writable ? "Editing on" : "Enable editing"}
            </Text>
          </Pressable>
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
          <Text style={writable ? styles.badgeDanger : styles.badge}>{writable ? "writable" : "read-only"}</Text>
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
                setFilters([]);
                setSearch("");
                setSort([]);
                if (layout.compact) setTreeVisible(false);
              }}
            />
          </View>
        ) : null}
        {showContent ? (
          <View style={styles.content}>
            <View style={styles.tabs}>
              {(["data", "structure", "sql"] as const).map((entry) => (
                <Pressable
                  key={entry}
                  accessibilityRole="button"
                  style={[styles.tab, tab === entry ? styles.tabActive : null]}
                  onPress={() => setTab(entry)}
                >
                  <Text style={tab === entry ? styles.tabTextActive : styles.tabText}>
                    {entry === "data" ? "Data" : entry === "structure" ? "Structure" : "SQL"}
                  </Text>
                </Pressable>
              ))}
              <Text numberOfLines={1} style={styles.subtitle}>
                {selected ?? "no object selected"}
              </Text>
            </View>

            {tab === "sql" ? (
              <SqlConsole theme={theme} layout={layout} handleId={handleId} object={selected} />
            ) : selected === null ? (
              <Text style={styles.hint}>Pick a table, view, or index on the left to inspect it.</Text>
            ) : tab === "structure" ? (
              <StructureView
                theme={theme}
                layout={layout}
                detail={selectedDetail}
                loading={detail.isPending}
                error={detail.error === null ? null : String(detail.error.message)}
              />
            ) : !isData ? (
              <Text style={styles.hint}>Indexes and triggers have no rows. Open the Structure tab.</Text>
            ) : detail.isError ? (
              <Text style={styles.error}>{String(detail.error.message)}</Text>
            ) : (
              <DataGrid
                theme={theme}
                layout={layout}
                handleId={handleId}
                object={selected}
                columns={visibleColumns}
                pageSize={pageSize}
                filters={filters}
                onFiltersChange={setFilters}
                search={search}
                onSearchChange={setSearch}
                sort={sort}
                onSortChange={setSort}
                reloadKey={reloadKey}
                onOpenCell={setCell}
                onInsertRow={writable ? () => setEditor({ mode: "insert", key: null, values: null }) : undefined}
                onEditRow={
                  writable
                    ? (target) => setEditor({ mode: "edit", key: target.key, values: target.row })
                    : undefined
                }
                onExport={() => setExportOpen(true)}
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

      {editor === null ? null : (
        <RowEditor
          theme={theme}
          layout={layout}
          handleId={handleId}
          object={selected ?? ""}
          columns={(selectedDetail?.columns ?? []) as ColumnMeta[]}
          mode={editor.mode}
          rowKey={editor.key}
          initialValues={editor.values}
          onClose={() => setEditor(null)}
          onSaved={() => setReloadKey((value) => value + 1)}
        />
      )}

      <ExportDialog
        theme={theme}
        layout={layout}
        handleId={handleId}
        object={selected ?? ""}
        defaultDirectory={directoryOf(database.path)}
        columns={visibleColumns}
        filters={filters}
        sort={sort}
        search={search}
        onClose={() => setExportOpen(false)}
        open={exportOpen}
      />

      <Modal
        title="Enable editing"
        open={consentOpen}
        onOpenChange={(next) => {
          if (!next) setConsentOpen(false);
        }}
      >
        <Modal.Content>
          <View style={styles.consent}>
            <Text style={styles.consentTitle}>{fileName}</Text>
            <Text style={styles.consentBody}>
              Editing opens this file for writing. Changes run immediately against the real database: no undo, and other
              programs reading the same file will see them.
            </Text>
            <Text style={styles.consentDanger}>
              Back up the file first if the data matters. Writes stay off until you enable them again after a reload.
            </Text>
            <View style={styles.consentActions}>
              <Pressable accessibilityRole="button" style={styles.button} onPress={() => setConsentOpen(false)}>
                <Text style={styles.buttonText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={[styles.button, styles.buttonDanger]}
                onPress={() => {
                  setConsentOpen(false);
                  applyWriting(true);
                }}
              >
                <Text style={styles.buttonTextDanger}>Enable editing</Text>
              </Pressable>
            </View>
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
