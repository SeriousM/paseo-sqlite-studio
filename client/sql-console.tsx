import { useSettings } from "@getpaseo/plugin/client";
import { FlatList, Modal, ScrollView, TextInput, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { viewerSettings } from "../shared/settings";
import { useJobRunner, type JobResult } from "./api";
import { columnWidth, displayCell } from "./format";
import type { ViewerHost } from "./types";

export interface SqlConsoleProps extends ViewerHost {
  handleId: string;
  object: string | null;
}

type SqlJobResult = Extract<JobResult, { kind: "sql" }>;

const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 34;
const HISTORY_LIMIT = 20;
const STARTER_LIMIT = 100;
const SAVED_LIMIT = 20;
const ROW_LIMITS = [100, 500, 1000] as const;
const EMPTY_HISTORY: string[] = [];
const EMPTY_SAVED: { name: string; sql: string }[] = [];

type RowLimit = (typeof ROW_LIMITS)[number];

/** Runs arbitrary read statements through the daemon-side `sql` job. */
export function SqlConsole({ theme, layout, handleId, object }: SqlConsoleProps) {
  const [sql, setSql] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [limit, setLimit] = useState<RowLimit>(500);
  const typedRef = useRef(false);

  const runner = useJobRunner();
  const settings = useSettings(viewerSettings);
  const toast = useToast();

  useEffect(() => {
    if (typedRef.current || object === null) return;
    setSql((current) => (current.length > 0 ? current : `select * from "${object}" limit ${STARTER_LIMIT}`));
  }, [object]);

  const styles = useMemo(
    () => ({
      root: { flex: 1, backgroundColor: theme.colors.surface0 },
      editor: {
        paddingHorizontal: layout.compact ? 8 : 12,
        paddingVertical: 8,
        gap: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      input: {
        minHeight: layout.compact ? 72 : 96,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        color: theme.colors.foreground,
        borderWidth: 1,
        borderColor: theme.colors.border,
        fontFamily: "monospace",
        fontSize: 12,
        textAlignVertical: "top" as const,
      },
      controls: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        flexWrap: "wrap" as const,
        gap: 8,
      },
      button: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      buttonActive: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
      buttonDisabled: { opacity: 0.4 },
      buttonText: { color: theme.colors.foreground, fontSize: 12 },
      buttonTextActive: { color: theme.colors.accentForeground, fontSize: 12 },
      label: { color: theme.colors.foregroundMuted, fontSize: 12 },
      status: { color: theme.colors.foregroundMuted, fontSize: 12 },
      note: { color: theme.colors.foregroundMuted, fontSize: 12 },
      warning: { color: theme.colors.statusWarning, fontSize: 12 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      results: {
        height: layout.compact ? 220 : 320,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      resultsScroll: { flex: 1 },
      headerRow: {
        flexDirection: "row" as const,
        height: HEADER_HEIGHT,
        alignItems: "center" as const,
        backgroundColor: theme.colors.surface1,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      headerCell: {
        paddingHorizontal: 8,
        justifyContent: "center" as const,
        borderRightWidth: 1,
        borderRightColor: theme.colors.border,
        height: HEADER_HEIGHT,
      },
      headerName: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      headerType: { color: theme.colors.foregroundMuted, fontSize: 10 },
      row: { flexDirection: "row" as const, height: ROW_HEIGHT, alignItems: "center" as const },
      rowAlt: { backgroundColor: theme.colors.surface1 },
      cell: {
        paddingHorizontal: 8,
        borderRightWidth: 1,
        borderRightColor: theme.colors.border,
        height: ROW_HEIGHT,
        justifyContent: "center" as const,
      },
      cellText: { color: theme.colors.foreground, fontSize: 12 },
      cellMuted: { color: theme.colors.foregroundMuted, fontSize: 12, fontStyle: "italic" as const },
      cellNumber: { color: theme.colors.foreground, fontSize: 12, textAlign: "right" as const },
      cellBlob: { color: theme.colors.accent, fontSize: 12, fontFamily: "monospace" },
      cellNull: { color: theme.colors.foregroundMuted, fontSize: 12, fontStyle: "italic" as const },
      message: {
        padding: layout.compact ? 16 : 24,
        color: theme.colors.foregroundMuted,
        fontSize: 13,
      },
      history: {
        paddingHorizontal: layout.compact ? 8 : 12,
        paddingVertical: 6,
        gap: 4,
      },
      historyList: { maxHeight: layout.compact ? 96 : 132 },
      savedRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingVertical: 4 },
      savedName: { flex: 1 },
      historyHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      historyEntry: { paddingVertical: 4 },
      historyText: { color: theme.colors.foregroundMuted, fontSize: 12, fontFamily: "monospace" },
    }),
    [theme, layout.compact],
  );

  const jobResult: JobResult | null = runner.status === null ? null : runner.status.result;
  const sqlResult: SqlJobResult | null = jobResult !== null && jobResult.kind === "sql" ? jobResult : null;
  const columns = useMemo(() => (sqlResult === null ? [] : sqlResult.result.columns), [sqlResult]);
  const rows = sqlResult === null ? [] : sqlResult.result.rows;
  const history = settings.status === "ready" ? settings.values.sqlHistory : EMPTY_HISTORY;
  const saved = settings.status === "ready" ? settings.values.savedQueries : EMPTY_SAVED;

  const widths = useMemo(() => columns.map((column) => columnWidth(column)), [columns]);
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);

  const toneStyle = (tone: string) => {
    if (tone === "number") return styles.cellNumber;
    if (tone === "blob") return styles.cellBlob;
    if (tone === "null") return styles.cellNull;
    if (tone === "muted") return styles.cellMuted;
    return styles.cellText;
  };

  const saveHistory = useCallback(
    (statement: string) => {
      if (settings.status !== "ready") return;
      const values = settings.values;
      const next = [statement, ...values.sqlHistory.filter((entry) => entry !== statement)].slice(0, HISTORY_LIMIT);
      void settings.save({ ...values, sqlHistory: next }, settings.revision);
    },
    [settings],
  );

  const clearHistory = useCallback(() => {
    if (settings.status !== "ready") return;
    void settings.save({ ...settings.values, sqlHistory: [] }, settings.revision);
  }, [settings]);

  function openSave() {
    const firstLine = sql.trim().split("\n")[0] ?? "";
    setSaveName(firstLine.slice(0, 60));
    setSaveOpen(true);
  }

  function saveQuery() {
    if (settings.status !== "ready") return;
    const statement = sql.trim();
    if (statement.length === 0) return;
    const name = saveName.trim().length > 0 ? saveName.trim() : statement.slice(0, 40);
    const next = [{ name, sql: statement }, ...settings.values.savedQueries.filter((entry) => entry.sql !== statement)].slice(
      0,
      SAVED_LIMIT,
    );
    void settings.save({ ...settings.values, savedQueries: next }, settings.revision);
    setSaveOpen(false);
  }

  function deleteSaved(statement: string) {
    if (settings.status !== "ready") return;
    void settings.save(
      { ...settings.values, savedQueries: settings.values.savedQueries.filter((entry) => entry.sql !== statement) },
      settings.revision,
    );
  }

  function changeSql(next: string) {
    typedRef.current = true;
    setSql(next);
  }

  function run(statement: string) {
    const trimmed = statement.trim();
    if (trimmed.length === 0 || runner.running) return;
    saveHistory(trimmed);
    void runner.start({ kind: "sql", handleId, sql: trimmed, limit });
  }

  function copyCell(text: string) {
    void copyText(text).then(
      () => toast.show("Copied to the clipboard."),
      () => toast.error("Could not copy to the clipboard."),
    );
  }

  const status = runner.status;
  const stateLabel =
    status === null
      ? "Idle"
      : status.state === "running"
        ? "Running"
        : status.state === "done"
          ? "Done"
          : status.state === "failed"
            ? "Failed"
            : "Cancelled";
  const statusText =
    status === null
      ? "Idle · run a read statement to see rows."
      : `${stateLabel} · ${status.elapsedMs} ms${sqlResult === null ? "" : ` · ${sqlResult.result.rows.length} rows`}`;
  const changes = sqlResult === null ? null : sqlResult.changes;
  const changesText =
    changes === null ? null : `${changes} row${changes === 1 ? "" : "s"} changed by this statement.`;
  const budgetExceeded = sqlResult !== null && sqlResult.budgetExceeded;
  const hasMore = sqlResult !== null && sqlResult.result.hasMore;
  const failure = status !== null && status.state === "failed" ? status.error : null;
  const emptyResults =
    status === null
      ? "Run a statement to see rows."
      : runner.running
        ? "Running…"
        : sqlResult === null
          ? "The statement returned no result set."
          : "The statement returned no rows.";

  return (
    <View style={styles.root}>
      <View style={styles.editor}>
        <TextInput
          value={sql}
          onChangeText={changeSql}
          placeholder="select * from ..."
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.input}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="SQL statement"
        />

        <View style={styles.controls}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Run statement"
            disabled={runner.running || sql.trim().length === 0}
            style={[styles.button, runner.running || sql.trim().length === 0 ? styles.buttonDisabled : null]}
            onPress={() => run(sql)}
          >
            <Text style={styles.buttonText}>Run</Text>
          </Pressable>
          {runner.running ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel statement"
              style={styles.button}
              onPress={() => void runner.cancel()}
            >
              <Text style={styles.buttonText}>Cancel</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save this statement"
            disabled={sql.trim().length === 0}
            style={[styles.button, sql.trim().length === 0 ? styles.buttonDisabled : null]}
            onPress={openSave}
          >
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
          <Text style={styles.label}>Row cap</Text>
          {ROW_LIMITS.map((choice) => (
            <Pressable
              key={choice}
              accessibilityRole="button"
              accessibilityLabel={`Row cap ${choice}`}
              style={[styles.button, limit === choice ? styles.buttonActive : null]}
              onPress={() => setLimit(choice)}
            >
              <Text style={limit === choice ? styles.buttonTextActive : styles.buttonText}>{choice}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.status}>{statusText}</Text>
        {changesText === null ? null : <Text style={styles.note}>{changesText}</Text>}
        {budgetExceeded ? (
          <Text style={styles.warning}>
            The scan hit its time budget, so more rows exist than came back.
          </Text>
        ) : null}
        {hasMore ? <Text style={styles.note}>Only the first {rows.length} rows came back.</Text> : null}
        {failure === null ? null : <Text style={styles.error}>{failure}</Text>}
        <Text style={styles.note}>This console only reads. Change rows in the row editor.</Text>
      </View>

      <View style={styles.results}>
        {rows.length === 0 ? (
          <Text style={styles.message}>{emptyResults}</Text>
        ) : (
          <ScrollView horizontal style={styles.resultsScroll} contentContainerStyle={{ width: totalWidth }}>
            <View>
              <View style={styles.headerRow}>
                {columns.map((column, index) => (
                  <View key={column.name} style={[styles.headerCell, { width: widths[index] ?? 160 }]}>
                    <Text numberOfLines={1} style={styles.headerName}>
                      {column.name}
                    </Text>
                    <Text numberOfLines={1} style={styles.headerType}>
                      {column.declaredType}
                    </Text>
                  </View>
                ))}
              </View>
              <FlatList
                data={rows}
                keyExtractor={(_row, index) => String(index)}
                getItemLayout={(_data, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
                initialNumToRender={24}
                windowSize={9}
                removeClippedSubviews
                renderItem={({ item, index }) => (
                  <View style={[styles.row, index % 2 === 1 ? styles.rowAlt : null]}>
                    {columns.map((column, columnIndex) => {
                      const cell = item[columnIndex] ?? null;
                      const display = displayCell(cell);
                      return (
                        <Pressable
                          key={column.name}
                          accessibilityRole="button"
                          accessibilityLabel={`${column.name}: ${display.title}`}
                          onPress={() => copyCell(display.text)}
                          style={[styles.cell, { width: widths[columnIndex] ?? 160 }]}
                        >
                          <Text numberOfLines={1} style={toneStyle(display.tone)}>
                            {display.clipped ? `${display.text}…` : display.text}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                )}
              />
            </View>
          </ScrollView>
        )}
      </View>

      <Modal
        title="Save query"
        open={saveOpen}
        onOpenChange={(next) => {
          if (!next) setSaveOpen(false);
        }}
      >
        <Modal.Content>
          <View style={styles.controls}>
            <TextInput
              value={saveName}
              onChangeText={setSaveName}
              placeholder="Name"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={[styles.input, styles.savedName]}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          <View style={styles.controls}>
            <Pressable accessibilityRole="button" style={styles.button} onPress={() => setSaveOpen(false)}>
              <Text style={styles.buttonText}>Cancel</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={styles.buttonActive} onPress={saveQuery}>
              <Text style={styles.buttonTextActive}>Save</Text>
            </Pressable>
          </View>
        </Modal.Content>
      </Modal>

      <View style={styles.history}>
        <View style={styles.historyHeader}>
          <Text style={styles.label}>Saved queries</Text>
        </View>
        {saved.length === 0 ? (
          <Text style={styles.note}>Save a statement to reuse it later.</Text>
        ) : (
          <ScrollView style={styles.historyList}>
            {saved.map((entry) => (
              <View key={entry.sql} style={styles.savedRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Use saved query ${entry.name}`}
                  style={styles.savedName}
                  onPress={() => changeSql(entry.sql)}
                >
                  <Text numberOfLines={1} style={styles.historyText}>
                    {entry.name}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Delete saved query ${entry.name}`}
                  onPress={() => deleteSaved(entry.sql)}
                >
                  <Text style={styles.buttonText}>Delete</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}
      </View>

      <View style={styles.history}>
        <View style={styles.historyHeader}>
          <Text style={styles.label}>Recent statements</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear history"
            disabled={history.length === 0}
            style={[styles.button, history.length === 0 ? styles.buttonDisabled : null]}
            onPress={clearHistory}
          >
            <Text style={styles.buttonText}>Clear history</Text>
          </Pressable>
        </View>
        {history.length === 0 ? (
          <Text style={styles.note}>Statements you run show up here.</Text>
        ) : (
          <ScrollView style={styles.historyList}>
            {history.map((statement, index) => (
              <Pressable
                key={`${index}:${statement}`}
                accessibilityRole="button"
                accessibilityLabel={`Use statement ${statement}`}
                style={styles.historyEntry}
                onPress={() => changeSql(statement)}
              >
                <Text numberOfLines={1} style={styles.historyText}>
                  {statement}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        )}
      </View>
    </View>
  );
}
