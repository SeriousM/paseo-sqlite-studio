import { Modal, TextInput, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useJobRunner } from "./api";
import type { Filter, Sort } from "./api";
import { formatBytesForHumans } from "./format";
import type { ViewerHost } from "./types";

const FORMATS = [
  { format: "csv", label: "CSV", extension: "csv" },
  { format: "tsv", label: "TSV", extension: "tsv" },
  { format: "json", label: "JSON", extension: "json" },
  { format: "jsonl", label: "JSON Lines", extension: "jsonl" },
  { format: "markdown", label: "Markdown", extension: "md" },
  { format: "sql", label: "SQL", extension: "sql" },
  { format: "html", label: "HTML", extension: "html" },
] as const;

type ExportFormat = (typeof FORMATS)[number]["format"];

const OPERATOR_LABELS: Record<Filter["operator"], string> = {
  eq: "=",
  ne: "≠",
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
  contains: "contains",
  notContains: "not contains",
  startsWith: "starts with",
  endsWith: "ends with",
  isNull: "is NULL",
  isNotNull: "is not NULL",
  isEmpty: "is empty",
  isNotEmpty: "is not empty",
};

/** Joins a directory and a file name without doubling the separator. */
function defaultPath(directory: string, object: string, format: ExportFormat): string {
  const base = directory.replace(/[/\\]+$/, "");
  const extension = FORMATS.find((entry) => entry.format === format)?.extension ?? format;
  return `${base}/${object}.${extension}`;
}

/** Writes a whole result set to a file on the daemon host. Filters and sort still apply. */
export interface ExportDialogProps extends ViewerHost {
  /** The parent owns visibility so the dialog can be mounted unconditionally. */
  open: boolean;
  handleId: string;
  object: string;
  defaultDirectory: string;
  columns: { name: string; declaredType: string; affinity: string }[];
  filters: Filter[];
  sort: Sort[];
  search: string;
  onClose: () => void;
}

export function ExportDialog({
  theme,
  layout,
  open,
  handleId,
  object,
  defaultDirectory,
  filters,
  sort,
  search,
  onClose,
}: ExportDialogProps) {
  const runner = useJobRunner();
  const toast = useToast();
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [path, setPath] = useState(() => defaultPath(defaultDirectory, object, "csv"));
  const [pathEdited, setPathEdited] = useState(false);
  const [overwrite, setOverwrite] = useState(false);

  useEffect(() => {
    setPathEdited(false);
  }, [defaultDirectory, object]);

  useEffect(() => {
    if (pathEdited) return;
    setPath(defaultPath(defaultDirectory, object, format));
  }, [defaultDirectory, object, format, pathEdited]);

  const styles = useMemo(
    () => ({
      body: { gap: 12 },
      subtitle: { color: theme.colors.foregroundMuted, fontSize: 12 },
      section: { gap: 6 },
      label: { color: theme.colors.foregroundMuted, fontSize: 11, textTransform: "uppercase" as const },
      chips: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      chip: {
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
      chipActive: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
      chipText: { color: theme.colors.foreground, fontSize: 12 },
      chipTextActive: { color: theme.colors.accentForeground, fontSize: 12 },
      input: {
        paddingHorizontal: 10,
        paddingVertical: layout.compact ? 6 : 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        color: theme.colors.foreground,
      },
      switchRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      switchRowOn: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2 },
      switchMark: { color: theme.colors.foregroundMuted, fontSize: 13, width: 16 },
      switchMarkOn: { color: theme.colors.accent, fontSize: 13, width: 16 },
      switchText: { color: theme.colors.foreground, fontSize: 12 },
      note: { color: theme.colors.foregroundMuted, fontSize: 12 },
      status: { color: theme.colors.foregroundMuted, fontSize: 12 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
      warning: { color: theme.colors.statusWarning, fontSize: 12 },
      card: {
        gap: 6,
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      resultPath: { color: theme.colors.foreground, fontSize: 13, fontFamily: "monospace" },
      actions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      button: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      buttonPrimary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
      buttonDisabled: { opacity: 0.4 },
      buttonText: { color: theme.colors.foreground, fontSize: 12 },
      buttonTextPrimary: { color: theme.colors.accentForeground, fontSize: 12 },
    }),
    [theme, layout.compact],
  );

  const status = runner.status;
  const running = runner.running;
  const result =
    status !== null && status.state === "done" && status.result !== null && status.result.kind === "export"
      ? status.result
      : null;
  const failure = status !== null && status.state === "failed" ? status.error : null;
  const cancelled = status !== null && status.state === "cancelled";

  const canStart = !running && path.trim().length > 0;

  const scope = useMemo(() => {
    const parts: string[] = [];
    if (filters.length > 0) {
      const described = filters
        .map((filter) =>
          filter.value === undefined
            ? `${filter.column} ${OPERATOR_LABELS[filter.operator]}`
            : `${filter.column} ${OPERATOR_LABELS[filter.operator]} ${JSON.stringify(filter.value)}`,
        )
        .join(", ");
      parts.push(`filters: ${described}`);
    }
    if (sort.length > 0) parts.push(`sort: ${sort.map((entry) => `${entry.column} ${entry.direction}`).join(", ")}`);
    if (search.trim().length > 0) parts.push(`search: ${JSON.stringify(search)}`);
    return parts.length === 0 ? "No filters or sort: this exports the whole table." : parts.join(" · ");
  }, [filters, sort, search]);

  function start() {
    if (!canStart) return;
    void runner.start({
      kind: "export",
      handleId,
      object,
      format,
      targetPath: path.trim(),
      overwrite,
      filters,
      sort,
      search: search.trim().length > 0 ? search : null,
    });
  }

  return (
    <Modal
      title="Export"
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content>
        <View style={styles.body}>
          <Text style={styles.subtitle}>{object}</Text>

          <View style={styles.section}>
            <Text style={styles.label}>Format</Text>
            <View style={styles.chips}>
              {FORMATS.map((entry) => (
                <Pressable
                  key={entry.format}
                  accessibilityRole="button"
                  accessibilityLabel={`Export as ${entry.label}`}
                  style={[styles.chip, entry.format === format ? styles.chipActive : null]}
                  onPress={() => setFormat(entry.format)}
                >
                  <Text style={entry.format === format ? styles.chipTextActive : styles.chipText}>{entry.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>Target file</Text>
            <TextInput
              value={path}
              onChangeText={(next) => {
                setPath(next);
                setPathEdited(true);
              }}
              placeholder="/path/to/export.csv"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <Pressable
            accessibilityRole="switch"
            accessibilityLabel="Overwrite an existing file"
            accessibilityState={{ checked: overwrite }}
            style={[styles.switchRow, overwrite ? styles.switchRowOn : null]}
            onPress={() => setOverwrite(!overwrite)}
          >
            <Text style={overwrite ? styles.switchMarkOn : styles.switchMark}>{overwrite ? "✓" : "○"}</Text>
            <Text style={styles.switchText}>Overwrite an existing file</Text>
          </Pressable>

          <Text style={styles.note}>{scope}</Text>

          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Start the export"
              disabled={!canStart}
              style={[styles.button, styles.buttonPrimary, canStart ? null : styles.buttonDisabled]}
              onPress={start}
            >
              <Text style={styles.buttonTextPrimary}>Start export</Text>
            </Pressable>
            {running ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel the export"
                style={styles.button}
                onPress={() => {
                  void runner.cancel();
                }}
              >
                <Text style={styles.buttonText}>Cancel</Text>
              </Pressable>
            ) : null}
          </View>

          {running && status !== null ? (
            <Text style={styles.status}>{`Exporting… ${status.elapsedMs} ms`}</Text>
          ) : null}

          {failure !== null ? <Text style={styles.error}>{failure}</Text> : null}

          {cancelled ? <Text style={styles.status}>Export cancelled.</Text> : null}

          {result !== null ? (
            <View style={styles.card}>
              <Text style={styles.resultPath}>{result.path}</Text>
              <Text style={styles.note}>
                {`${formatBytesForHumans(result.bytes)} · ${result.rows} ${result.rows === 1 ? "row" : "rows"}`}
              </Text>
              {result.truncated ? (
                <Text style={styles.warning}>Truncated: the export stopped before every row was written.</Text>
              ) : null}
              <View style={styles.actions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Copy the exported file path"
                  style={styles.button}
                  onPress={() => {
                    void copyText(result.path).then(
                      () => toast.show("Copied the path."),
                      () => toast.error("Could not copy the path."),
                    );
                  }}
                >
                  <Text style={styles.buttonText}>Copy path</Text>
                </Pressable>
              </View>
              <Text style={styles.note}>The file was written on the machine running the daemon.</Text>
            </View>
          ) : null}

          <View style={styles.actions}>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" style={styles.button} onPress={onClose}>
              <Text style={styles.buttonText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}
