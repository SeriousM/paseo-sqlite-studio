import { Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Filter } from "./api";
import type { ViewerHost } from "./types";

export interface FilterModalProps extends ViewerHost {
  open: boolean;
  columns: { name: string; declaredType: string; affinity: string }[];
  filters: Filter[];
  onApply: (filters: Filter[]) => void;
  onClose: () => void;
}

type Operator = Filter["operator"];

const TEXT_OPERATORS: Array<{ operator: Operator; label: string; needsValue: boolean }> = [
  { operator: "contains", label: "contains", needsValue: true },
  { operator: "notContains", label: "not contains", needsValue: true },
  { operator: "startsWith", label: "starts with", needsValue: true },
  { operator: "endsWith", label: "ends with", needsValue: true },
  { operator: "eq", label: "=", needsValue: true },
  { operator: "ne", label: "≠", needsValue: true },
  { operator: "isEmpty", label: "is empty", needsValue: false },
  { operator: "isNotEmpty", label: "is not empty", needsValue: false },
  { operator: "isNull", label: "is NULL", needsValue: false },
  { operator: "isNotNull", label: "is not NULL", needsValue: false },
];

const NUMBER_OPERATORS: Array<{ operator: Operator; label: string; needsValue: boolean }> = [
  { operator: "eq", label: "=", needsValue: true },
  { operator: "ne", label: "≠", needsValue: true },
  { operator: "gt", label: ">", needsValue: true },
  { operator: "gte", label: "≥", needsValue: true },
  { operator: "lt", label: "<", needsValue: true },
  { operator: "lte", label: "≤", needsValue: true },
  { operator: "isNull", label: "is NULL", needsValue: false },
  { operator: "isNotNull", label: "is not NULL", needsValue: false },
];

const NULL_OPERATORS: Array<{ operator: Operator; label: string; needsValue: boolean }> = [
  { operator: "isNull", label: "is NULL", needsValue: false },
  { operator: "isNotNull", label: "is not NULL", needsValue: false },
];

function operatorsFor(affinity: string) {
  if (affinity === "integer" || affinity === "real" || affinity === "numeric") return NUMBER_OPERATORS;
  if (affinity === "blob") return NULL_OPERATORS;
  return TEXT_OPERATORS;
}

function describeFilter(filter: Filter, columns: FilterModalProps["columns"]): string {
  const column = columns.find((entry) => entry.name === filter.column);
  const operator = operatorsFor(column?.affinity ?? "text").find((entry) => entry.operator === filter.operator);
  const label = operator?.label ?? filter.operator;
  return operator?.needsValue === false
    ? `${filter.column} ${label}`
    : `${filter.column} ${label} ${JSON.stringify(filter.value ?? "")}`;
}

export function FilterModal({ theme, layout, open, columns, filters, onApply, onClose }: FilterModalProps) {
  const [column, setColumn] = useState<string>(columns[0]?.name ?? "");
  const [operator, setOperator] = useState<Operator>("contains");
  const [value, setValue] = useState("");
  const [draft, setDraft] = useState<Filter[]>(filters);

  const activeColumn = columns.find((entry) => entry.name === column);
  const operators = operatorsFor(activeColumn?.affinity ?? "text");
  const selected = operators.find((entry) => entry.operator === operator) ?? operators[0];

  const styles = useMemo(
    () => ({
      body: { gap: 12 },
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
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      filterRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      filterText: { color: theme.colors.foreground, fontSize: 12, flex: 1 },
      action: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      actionPrimary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
      actionText: { color: theme.colors.foreground, fontSize: 12 },
      actionTextPrimary: { color: theme.colors.accentForeground, fontSize: 12 },
      empty: { color: theme.colors.foregroundMuted, fontSize: 12 },
      actions: { flexDirection: "row" as const, gap: 8, justifyContent: "flex-end" as const },
    }),
    [theme, layout.compact],
  );

  const canAdd = column.length > 0 && (selected?.needsValue === false || value.length > 0);

  function addFilter() {
    if (!canAdd || !selected) return;
    const next: Filter = selected.needsValue
      ? { column, operator: selected.operator, value }
      : { column, operator: selected.operator };
    setDraft([...draft, next]);
    setValue("");
  }

  return (
    <Modal
      title="Filters"
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content>
        <View style={styles.body}>
          <View style={styles.section}>
            <Text style={styles.label}>Column</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {columns.map((entry) => (
                <Pressable
                  key={entry.name}
                  accessibilityRole="button"
                  accessibilityLabel={`Filter column ${entry.name}`}
                  style={[styles.chip, entry.name === column ? styles.chipActive : null]}
                  onPress={() => {
                    setColumn(entry.name);
                    const nextOperators = operatorsFor(entry.affinity);
                    setOperator(nextOperators[0]?.operator ?? "eq");
                  }}
                >
                  <Text style={entry.name === column ? styles.chipTextActive : styles.chipText}>{entry.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>Condition</Text>
            <View style={styles.chips}>
              {operators.map((entry) => (
                <Pressable
                  key={entry.operator}
                  accessibilityRole="button"
                  style={[styles.chip, entry.operator === operator ? styles.chipActive : null]}
                  onPress={() => setOperator(entry.operator)}
                >
                  <Text style={entry.operator === operator ? styles.chipTextActive : styles.chipText}>{entry.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          {selected?.needsValue === false ? null : (
            <TextInput
              value={value}
              onChangeText={setValue}
              placeholder="Value"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={addFilter}
            />
          )}

          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={!canAdd}
              style={[styles.action, styles.actionPrimary, canAdd ? null : { opacity: 0.4 }]}
              onPress={addFilter}
            >
              <Text style={styles.actionTextPrimary}>Add filter</Text>
            </Pressable>
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>Active filters</Text>
            {draft.length === 0 ? (
              <Text style={styles.empty}>No filters. Every row is shown.</Text>
            ) : (
              draft.map((filter, index) => (
                <View key={`${filter.column}-${filter.operator}-${index}`} style={styles.filterRow}>
                  <Text numberOfLines={1} style={styles.filterText}>
                    {describeFilter(filter, columns)}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove filter on ${filter.column}`}
                    onPress={() => setDraft(draft.filter((_entry, position) => position !== index))}
                  >
                    <Text style={styles.filterText}>Remove</Text>
                  </Pressable>
                </View>
              ))
            )}
          </View>

          <View style={styles.actions}>
            <Pressable accessibilityRole="button" style={styles.action} onPress={() => setDraft([])}>
              <Text style={styles.actionText}>Clear all</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={[styles.action, styles.actionPrimary]}
              onPress={() => {
                onApply(draft);
                onClose();
              }}
            >
              <Text style={styles.actionTextPrimary}>Apply</Text>
            </Pressable>
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}
