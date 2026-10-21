import { Modal, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useCellValue } from "./api";
import type { Cell, CellValue, KeyValue } from "./api";
import { describeCell, formatBytesForHumans } from "./format";
import type { ViewerHost } from "./types";

/**
 * The full value behind one grid cell. The grid shows previews; this fetches the
 * whole payload on demand, so a large blob never travels unless it is looked at.
 */
export interface CellDetailProps extends ViewerHost {
  visible: boolean;
  handleId: string;
  object: string;
  column: string;
  /** Named `rowKey` because React reserves `key` for list identity. */
  rowKey: KeyValue[] | null;
  preview: Cell;
  onClose: () => void;
}

export function CellDetail({
  theme,
  layout,
  visible,
  handleId,
  object,
  column,
  rowKey,
  preview,
  onClose,
}: CellDetailProps) {
  const { mutate } = useCellValue();
  const toast = useToast();
  const [value, setValue] = useState<CellValue | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || rowKey === null) return;
    setValue(null);
    setFetchError(null);
    mutate(
      { handleId, object, column, key: rowKey },
      {
        onSuccess: (data) => setValue(data),
        onError: (error) => setFetchError(error instanceof Error ? error.message : String(error)),
      },
    );
  }, [visible, handleId, object, column, rowKey, mutate]);

  const styles = useMemo(
    () => ({
      root: { gap: 10 },
      subtitle: { color: theme.colors.foregroundMuted, fontSize: 12 },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      block: {
        maxHeight: layout.compact ? 220 : 320,
        padding: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      mono: { color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" },
      note: { color: theme.colors.foregroundMuted, fontSize: 12 },
      message: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
      actions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      button: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      buttonDisabled: { opacity: 0.4 },
      buttonText: { color: theme.colors.foreground, fontSize: 12 },
    }),
    [theme, layout.compact],
  );

  const payload = value === null ? null : value.kind === "blob" ? value.base64 : value.text;

  function copy() {
    if (payload === null) return;
    void copyText(payload).then(
      () => toast.show("Copied to the clipboard."),
      () => toast.error("Could not copy to the clipboard."),
    );
  }

  return (
    <Modal
      title={column}
      open={visible}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content scrollable={false}>
        <Text style={styles.subtitle}>{object}</Text>

        {fetchError !== null ? (
          <Text style={styles.error}>{fetchError}</Text>
        ) : value === null ? (
          <>
            <Text style={styles.meta}>{describeCell(preview)}</Text>
            {rowKey === null ? null : <Text style={styles.message}>Loading full value…</Text>}
          </>
        ) : (
          <>
            <Text style={styles.meta}>
              {`${value.kind} · ${formatBytesForHumans(value.sizeBytes)}${value.truncated ? " · truncated" : ""}`}
            </Text>
            {value.kind === "text" ? (
              <ScrollView style={styles.block}>
                <Text style={styles.mono}>{value.text ?? ""}</Text>
              </ScrollView>
            ) : value.kind === "blob" ? (
              <>
                <ScrollView style={styles.block}>
                  <Text style={styles.mono}>{value.base64 ?? ""}</Text>
                </ScrollView>
                <Text style={styles.note}>Binary data is shown as base64.</Text>
              </>
            ) : (
              <Text style={styles.mono}>NULL</Text>
            )}
          </>
        )}

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy this value"
            disabled={payload === null}
            style={[styles.button, payload === null ? styles.buttonDisabled : null]}
            onPress={copy}
          >
            <Text style={styles.buttonText}>Copy</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={styles.button}
            onPress={onClose}
          >
            <Text style={styles.buttonText}>Close</Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}
