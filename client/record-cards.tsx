import { FlatList } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { Cell, KeyValue } from "./api";
import type { CellTarget, GridColumn } from "./data-grid";
import { displayCell } from "./format";
import type { ViewerHost } from "./types";

/**
 * The compact-mode view of a table: one card per row instead of a scrolling grid.
 * Rows arrive preview-sized and keys carry full values, so the header can name a
 * row precisely while the fields stay cheap to render.
 */
export interface RecordCardsProps extends ViewerHost {
  columns: GridColumn[];
  rows: Cell[][];
  keys: KeyValue[][];
  loading: boolean;
  error: string | null;
  onOpenCell: (target: CellTarget) => void;
  children?: ReactNode;
}

/** Row identity reads as text even before a cell is opened. */
function keyText(value: KeyValue): string {
  if (value === null) return "NULL";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value.kind === "bigint") return value.value;
  return value.base64.length > 0 ? `0x${value.base64.slice(0, 16)}…` : "BLOB";
}

export function RecordCards({ theme, layout, columns, rows, keys, loading, error, onOpenCell, children }: RecordCardsProps) {
  const styles = useMemo(
    () => ({
      container: { flex: 1, backgroundColor: theme.colors.surface0 },
      list: { flex: 1 },
      card: {
        marginHorizontal: layout.compact ? 8 : 12,
        marginVertical: 4,
        padding: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      cardHeader: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      field: { paddingVertical: 6, borderTopWidth: 1, borderTopColor: theme.colors.border },
      fieldWide: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingVertical: 6,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
      },
      fieldName: { color: theme.colors.foregroundMuted, fontSize: 11 },
      fieldNameFixed: { width: 110 },
      fieldValue: { flexShrink: 1 },
      valueText: { color: theme.colors.foreground, fontSize: 13 },
      valueMuted: { color: theme.colors.foregroundMuted, fontSize: 13, fontStyle: "italic" as const },
      valueNumber: { color: theme.colors.foreground, fontSize: 13, textAlign: "right" as const },
      valueBlob: { color: theme.colors.accent, fontSize: 13, fontFamily: "monospace" },
      valueNull: { color: theme.colors.foregroundMuted, fontSize: 13, fontStyle: "italic" as const },
      message: {
        padding: layout.compact ? 16 : 24,
        color: theme.colors.foregroundMuted,
        fontSize: 13,
      },
      error: { padding: layout.compact ? 16 : 24, color: theme.colors.statusDanger, fontSize: 13 },
    }),
    [theme, layout.compact],
  );

  const toneStyle = (tone: string) => {
    if (tone === "number") return styles.valueNumber;
    if (tone === "blob") return styles.valueBlob;
    if (tone === "null") return styles.valueNull;
    if (tone === "muted") return styles.valueMuted;
    return styles.valueText;
  };

  return (
    <View style={styles.container}>
      {children}
      {error !== null ? <Text style={styles.error}>{error}</Text> : null}
      {loading ? <Text style={styles.message}>Loading…</Text> : null}
      <FlatList
        style={styles.list}
        data={rows}
        keyExtractor={(_row, index) => String(index)}
        initialNumToRender={16}
        windowSize={9}
        renderItem={({ item, index }) => {
          const rowKey = keys[index] ?? [];
          const keySuffix = rowKey.length === 0 ? "" : ` · ${rowKey.map(keyText).join(" · ")}`;
          return (
            <View style={styles.card}>
              <Text numberOfLines={1} style={styles.cardHeader}>
                {`#${index + 1}${keySuffix}`}
              </Text>
              {columns.map((column, columnIndex) => {
                const cell = item[columnIndex] ?? null;
                const display = displayCell(cell);
                return (
                  <Pressable
                    key={column.name}
                    accessibilityRole="button"
                    accessibilityLabel={`${column.name}: ${display.title}`}
                    onPress={() => onOpenCell({ column: column.name, key: rowKey, cell, row: item })}
                    style={layout.compact ? styles.field : styles.fieldWide}
                  >
                    <Text numberOfLines={1} style={[styles.fieldName, layout.compact ? null : styles.fieldNameFixed]}>
                      {column.name}
                    </Text>
                    <Text numberOfLines={2} style={[toneStyle(display.tone), styles.fieldValue]}>
                      {display.clipped ? `${display.text}…` : display.text}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          );
        }}
        ListEmptyComponent={
          !loading && error === null ? <Text style={styles.message}>This table has no rows.</Text> : null
        }
      />
    </View>
  );
}
