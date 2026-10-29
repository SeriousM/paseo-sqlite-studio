import { Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useDeleteRow, useInsertRow, useUpdateRow } from "./api";
import type { Cell, ColumnAssignment, ColumnMeta, KeyValue, WriteValue } from "./api";
import type { ViewerHost } from "./types";

export interface RowEditorProps extends ViewerHost {
  handleId: string;
  object: string;
  columns: ColumnMeta[];
  mode: "insert" | "edit";
  rowKey: KeyValue[] | null;
  initialValues: Cell[] | null;
  /** Column to focus when the form opens, usually the cell that was clicked. */
  focusColumn?: string | null;
  onClose: () => void;
  onSaved: () => void;
}

interface FieldState {
  text: string;
  isNull: boolean;
}

interface WritableField {
  column: ColumnMeta;
  index: number;
}

const EMPTY_FIELD: FieldState = { text: "", isNull: false };
const INTEGER_LITERAL = /^[+-]?\d+$/;
const SAFE_DIGITS = 15;

/** Writable columns only: generated and hidden columns cannot be written. */
function writableFields(columns: ColumnMeta[]): WritableField[] {
  const fields: WritableField[] = [];
  columns.forEach((column, index) => {
    if (column.hidden === "normal") fields.push({ column, index });
  });
  return fields;
}

function initialFieldState(cell: Cell): FieldState {
  if (cell === null) return { text: "", isNull: true };
  if (typeof cell === "number") return { text: String(cell), isNull: false };
  if (typeof cell === "string") return { text: cell, isNull: false };
  if (cell.kind === "bigint") return { text: cell.value, isNull: false };
  if (cell.kind === "longtext") return { text: cell.preview, isNull: false };
  return { text: cell.previewHex, isNull: false };
}

/**
 * The row as the user saw it. Sent with a write so the daemon can refuse to
 * overwrite a row that changed elsewhere. Clipped cells (long text, blobs) are
 * skipped, because their preview cannot be compared with the stored value.
 */
function buildExpected(fields: WritableField[], initialValues: Cell[] | null): ColumnAssignment[] {
  if (initialValues === null) return [];
  const expected: ColumnAssignment[] = [];
  for (const { column, index } of fields) {
    const cell = initialValues[index];
    if (cell === undefined) continue;
    if (cell === null || typeof cell === "string" || typeof cell === "number") {
      expected.push({ column: column.name, value: cell });
      continue;
    }
    if (cell.kind === "bigint") expected.push({ column: column.name, value: cell });
  }
  return expected.slice(0, 64);
}

function buildFieldStates(fields: WritableField[], initialValues: Cell[] | null): Record<string, FieldState> {
  const states: Record<string, FieldState> = {};
  for (const { column, index } of fields) {
    const cell = initialValues === null ? undefined : initialValues[index];
    states[column.name] = cell === undefined ? EMPTY_FIELD : initialFieldState(cell);
  }
  return states;
}

/** The value a form field hands to a write, per the column's affinity. */
function toWriteValue(column: ColumnMeta, text: string, isNull: boolean): WriteValue {
  if (isNull) return null;
  if (text.length === 0) return "";
  const trimmed = text.trim();
  if (
    column.affinity === "integer" &&
    INTEGER_LITERAL.test(trimmed) &&
    trimmed.replace(/^[+-]/, "").length > SAFE_DIGITS
  ) {
    return { kind: "bigint", value: trimmed };
  }
  if (column.affinity === "integer" || column.affinity === "real" || column.affinity === "numeric") {
    if (trimmed.length > 0 && Number.isFinite(Number(trimmed))) return Number(trimmed);
  }
  if (column.affinity === "blob") return { kind: "blob", base64: text.replace(/\s+/g, "") };
  return text;
}

function describeKeyValue(value: KeyValue | undefined): string {
  if (value === undefined) return "?";
  if (value === null) return "NULL";
  if (typeof value === "number" || typeof value === "string") return String(value);
  if (value.kind === "bigint") return value.value;
  return `0x${value.base64.slice(0, 16)}`;
}

function describeKey(rowKey: KeyValue[] | null, keyColumns: ColumnMeta[]): string {
  if (rowKey === null || rowKey.length === 0) return "unknown";
  if (keyColumns.length === rowKey.length) {
    return keyColumns.map((column, index) => `${column.name} = ${describeKeyValue(rowKey[index])}`).join(", ");
  }
  return rowKey.map(describeKeyValue).join(", ");
}

export function RowEditor({
  theme,
  layout,
  handleId,
  object,
  columns,
  mode,
  rowKey,
  initialValues,
  focusColumn = null,
  onClose,
  onSaved,
}: RowEditorProps) {
  const insertRow = useInsertRow();
  const updateRow = useUpdateRow();
  const removeRow = useDeleteRow();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const fields = useMemo(() => writableFields(columns), [columns]);
  const keyColumns = useMemo(
    () =>
      columns
        .filter((column) => column.primaryKeyPosition > 0)
        .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition),
    [columns],
  );
  const initialStates = useMemo(() => buildFieldStates(fields, initialValues), [fields, initialValues]);
  const expected = useMemo(() => buildExpected(fields, initialValues), [fields, initialValues]);
  const signature = useMemo(
    () => `${mode}:${object}:${JSON.stringify(initialStates)}`,
    [mode, object, initialStates],
  );

  const [values, setValues] = useState<Record<string, FieldState>>(initialStates);

  useEffect(() => {
    setValues(initialStates);
    setConfirmDelete(false);
    insertRow.reset();
    updateRow.reset();
    removeRow.reset();
  }, [signature]);

  const assignments = useMemo(() => {
    const changes: ColumnAssignment[] = [];
    for (const { column } of fields) {
      const state = values[column.name];
      if (state === undefined) continue;
      const initial = initialStates[column.name] ?? EMPTY_FIELD;
      if (mode === "edit" && state.text === initial.text && state.isNull === initial.isNull) continue;
      if (mode === "insert" && !state.isNull && state.text.length === 0) continue;
      changes.push({ column: column.name, value: toWriteValue(column, state.text, state.isNull) });
    }
    return changes;
  }, [fields, values, initialStates, mode]);

  const pending = insertRow.isPending || updateRow.isPending || removeRow.isPending;
  const failure = insertRow.error ?? updateRow.error ?? removeRow.error;
  const errorMessage = failure === null ? null : failure instanceof Error ? failure.message : String(failure);
  const missingKey = mode === "edit" && rowKey === null;
  const canSubmit = assignments.length > 0 && !pending && !missingKey;

  function updateField(name: string, patch: Partial<FieldState>) {
    setValues((current) => {
      const existing = current[name];
      if (existing === undefined) return current;
      return { ...current, [name]: { ...existing, ...patch } };
    });
  }

  function submit() {
    if (!canSubmit) return;
    if (mode === "insert") {
      insertRow.mutate(
        { handleId, object, values: assignments },
        {
          onSuccess: () => {
            onSaved();
            onClose();
          },
        },
      );
      return;
    }
    if (rowKey === null) return;
    updateRow.mutate(
      { handleId, object, key: rowKey, changes: assignments, expected },
      {
        onSuccess: () => {
          onSaved();
          onClose();
        },
      },
    );
  }

  function confirmRemove() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    if (rowKey === null) return;
    removeRow.mutate(
      { handleId, object, key: rowKey, expected },
      {
        onSuccess: () => {
          onSaved();
          onClose();
        },
      },
    );
  }

  const styles = useMemo(
    () => ({
      body: { gap: layout.compact ? 10 : 14 },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      field: { gap: 6 },
      fieldHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      fieldName: { color: theme.colors.foreground, fontSize: 13, flexShrink: 1 },
      fieldMeta: { color: theme.colors.foregroundMuted, fontSize: 11 },
      fieldRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      input: {
        flex: 1,
        paddingHorizontal: 10,
        paddingVertical: layout.compact ? 6 : 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        color: theme.colors.foreground,
        fontSize: 13,
      },
      inputDisabled: { opacity: 0.5 },
      nullToggle: {
        paddingHorizontal: 10,
        paddingVertical: layout.compact ? 6 : 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      nullToggleActive: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
      nullText: { color: theme.colors.foregroundMuted, fontSize: 11 },
      nullTextActive: { color: theme.colors.accentForeground, fontSize: 11 },
      hint: { color: theme.colors.statusDanger, fontSize: 11 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      empty: { color: theme.colors.foregroundMuted, fontSize: 12 },
      actions: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
      },
      spacer: { flex: 1 },
      action: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      actionPrimary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
      actionDanger: { borderColor: theme.colors.statusDanger },
      actionDisabled: { opacity: 0.4 },
      actionText: { color: theme.colors.foreground, fontSize: 12 },
      actionTextPrimary: { color: theme.colors.accentForeground, fontSize: 12 },
      actionTextDanger: { color: theme.colors.statusDanger, fontSize: 12 },
    }),
    [theme, layout.compact],
  );

  return (
    <Modal
      title={mode === "insert" ? "Insert row" : "Edit row"}
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content>
        <View style={styles.body}>
          <Text style={styles.meta}>
            {mode === "insert"
              ? `New row in ${object}`
              : `Editing ${object} · row ${describeKey(rowKey, keyColumns)}`}
          </Text>

          {fields.length === 0 ? (
            <Text style={styles.empty}>This object has no writable columns.</Text>
          ) : (
            fields.map(({ column }) => {
              const state = values[column.name] ?? EMPTY_FIELD;
              const declared = column.declaredType.length > 0 ? column.declaredType : column.affinity;
              const meta = [
                declared,
                column.notNull ? "NOT NULL" : "NULL",
                mode === "insert" ? "optional" : null,
              ]
                .filter((part): part is string => part !== null)
                .join(" · ");
              const cleared = column.notNull && !state.isNull && state.text.length === 0;
              return (
                <View key={column.name} style={styles.field}>
                  <View style={styles.fieldHeader}>
                    <Text style={styles.fieldName}>{column.name}</Text>
                    <Text style={styles.fieldMeta}>{meta}</Text>
                  </View>
                  <View style={styles.fieldRow}>
                    <TextInput
                      value={state.text}
                      autoFocus={focusColumn === column.name}
                      onChangeText={(text) => updateField(column.name, { text })}
                      editable={!state.isNull}
                      placeholder={column.affinity === "blob" ? "base64" : declared}
                      placeholderTextColor={theme.colors.foregroundMuted}
                      style={[styles.input, state.isNull ? styles.inputDisabled : null]}
                      autoCapitalize="none"
                      autoCorrect={false}
                      accessibilityLabel={`${column.name} value`}
                    />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${state.isNull ? "Clear NULL for" : "Set NULL for"} ${column.name}`}
                      style={[styles.nullToggle, state.isNull ? styles.nullToggleActive : null]}
                      onPress={() => updateField(column.name, { isNull: !state.isNull })}
                    >
                      <Text style={state.isNull ? styles.nullTextActive : styles.nullText}>NULL</Text>
                    </Pressable>
                  </View>
                  {cleared ? <Text style={styles.hint}>NOT NULL column left empty.</Text> : null}
                </View>
              );
            })
          )}

          {errorMessage === null ? null : <Text style={styles.error}>{errorMessage}</Text>}

          <View style={styles.actions}>
            {mode === "edit" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={confirmDelete ? "Confirm delete row" : "Delete row"}
                disabled={pending || rowKey === null}
                style={[
                  styles.action,
                  styles.actionDanger,
                  pending || rowKey === null ? styles.actionDisabled : null,
                ]}
                onPress={confirmRemove}
              >
                <Text style={styles.actionTextDanger}>{confirmDelete ? "Confirm delete" : "Delete row"}</Text>
              </Pressable>
            ) : null}
            <View style={styles.spacer} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              style={styles.action}
              onPress={onClose}
            >
              <Text style={styles.actionText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={mode === "insert" ? "Insert row" : "Save changes"}
              disabled={!canSubmit}
              style={[styles.action, styles.actionPrimary, canSubmit ? null : styles.actionDisabled]}
              onPress={submit}
            >
              <Text style={styles.actionTextPrimary}>{mode === "insert" ? "Insert row" : "Save changes"}</Text>
            </Pressable>
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}
