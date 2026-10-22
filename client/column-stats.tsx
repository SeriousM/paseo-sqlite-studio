import { Modal, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useColumnStats, type Filter } from "./api";
import { describeCell } from "./format";
import type { ViewerHost } from "./types";

export interface ColumnStatsProps extends ViewerHost {
  open: boolean;
  hostId: string;
  hostLabel: string;
  handleId: string;
  object: string;
  columns: { name: string; declaredType: string; affinity: string }[];
  column: string;
  onColumnChange: (column: string) => void;
  filters: Filter[];
  search: string;
  /** Current width override in pixels, or null for the automatic width. */
  width: number | null;
  onSetWidth: (width: number | null) => void;
  onClose: () => void;
}

const WIDTH_PRESETS = [100, 160, 220, 300];

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const [whole, fraction] = String(value).split(".");
  const grouped = (whole ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return fraction ? `${grouped}.${fraction.slice(0, 3)}` : grouped;
}

/**
 * Aggregates for one column. They cover the whole filtered set, so the numbers stay
 * true while the grid itself only holds one page.
 */
export function ColumnStats({
  theme,
  layout,
  open,
  hostId,
  hostLabel,
  handleId,
  object,
  columns,
  column,
  onColumnChange,
  filters,
  search,
  width,
  onSetWidth,
  onClose,
}: ColumnStatsProps) {
  const stats = useColumnStats(hostId, handleId, { object, column, filters, search }, open && column.length > 0);

  const styles = useMemo(
    () => ({
      body: { gap: 12 },
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
      row: {
        flexDirection: "row" as const,
        alignItems: "baseline" as const,
        justifyContent: "space-between" as const,
        gap: 12,
        paddingVertical: 5,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      rowLabel: { color: theme.colors.foregroundMuted, fontSize: 12 },
      rowValue: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      note: { color: theme.colors.foregroundMuted, fontSize: 11 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      empty: { color: theme.colors.foregroundMuted, fontSize: 12 },
    }),
    [theme],
  );

  const value = stats.data;
  const line = (label: string, amount: string) => (
    <View key={label} style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{amount}</Text>
    </View>
  );

  return (
    <Modal
      title="Column statistics"
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content scrollable={false}>
        <View style={styles.body}>
          <Text style={styles.note}>
            {object} on {hostLabel}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {columns.map((entry) => (
              <Pressable
                key={entry.name}
                accessibilityRole="button"
                accessibilityLabel={`Statistics for ${entry.name}`}
                style={[styles.chip, entry.name === column ? styles.chipActive : null]}
                onPress={() => onColumnChange(entry.name)}
              >
                <Text style={entry.name === column ? styles.chipTextActive : styles.chipText}>{entry.name}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <View style={{ gap: 6 }}>
            <Text style={styles.label}>Column width</Text>
            <View style={styles.chips}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Automatic column width"
                style={[styles.chip, width === null ? styles.chipActive : null]}
                onPress={() => onSetWidth(null)}
              >
                <Text style={width === null ? styles.chipTextActive : styles.chipText}>Auto</Text>
              </Pressable>
              {WIDTH_PRESETS.map((preset) => (
                <Pressable
                  key={preset}
                  accessibilityRole="button"
                  accessibilityLabel={`Column width ${preset}`}
                  style={[styles.chip, width === preset ? styles.chipActive : null]}
                  onPress={() => onSetWidth(preset)}
                >
                  <Text style={width === preset ? styles.chipTextActive : styles.chipText}>{preset}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          {stats.isError ? (
            <Text style={styles.error}>{String(stats.error.message)}</Text>
          ) : value === undefined ? (
            <Text style={styles.empty}>Loading…</Text>
          ) : (
            <>
              {line("Rows", formatNumber(value.rows))}
              {line("Values", formatNumber(value.values))}
              {line("NULLs", formatNumber(value.nulls))}
              {value.numeric && value.sum !== null ? line("Sum", formatNumber(value.sum)) : null}
              {value.numeric && value.average !== null ? line("Average", formatNumber(value.average)) : null}
              {value.min === null || value.min === undefined ? null : line("Min", describeCell(value.min))}
              {value.max === null || value.max === undefined ? null : line("Max", describeCell(value.max))}
              <Text style={styles.note}>
                {filters.length > 0 || search.length > 0
                  ? "Over every row matching the current filters, not only this page."
                  : "Over every row in the table, not only this page."}
              </Text>
            </>
          )}
        </View>
      </Modal.Content>
    </Modal>
  );
}
