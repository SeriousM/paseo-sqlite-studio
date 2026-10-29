import { Modal, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, Text, TextInput, View } from "react-native";
import { useCellValue, useSaveBlob } from "./api";
import type { Cell, CellValue, KeyValue } from "./api";
import { fromBase64, toHex } from "../shared/cell-encoding";
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
  /** Where a saved binary value goes by default: the database's directory. */
  defaultDirectory: string;
  /** Present when rows can be edited; opens the row form for this row. */
  onEditRow?: (() => void) | undefined;
  onClose: () => void;
}

const HEX_PREVIEW_BYTES = 512;

/** Enough magic-byte sniffing to show an image instead of its bytes. */
function imageMime(bytes: Uint8Array): string | null {
  const at = (index: number) => bytes[index] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45) {
    return "image/webp";
  }
  return null;
}

function hexDump(bytes: Uint8Array, limit: number): string {
  const lines: string[] = [];
  const end = Math.min(bytes.length, limit);
  for (let offset = 0; offset < end; offset += 16) {
    const slice = bytes.subarray(offset, Math.min(offset + 16, end));
    const hex = Array.from(slice, (byte) => toHex(new Uint8Array([byte]), 1))
      .join(" ")
      .padEnd(47, " ");
    const ascii = Array.from(slice, (byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".")).join("");
    lines.push(`${offset.toString(16).padStart(6, "0")}  ${hex}  ${ascii}`);
  }
  return lines.join("\n");
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
  defaultDirectory,
  onEditRow,
  onClose,
}: CellDetailProps) {
  const { mutate } = useCellValue();
  const saveBlob = useSaveBlob();
  const [savePath, setSavePath] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const toast = useToast();
  const [value, setValue] = useState<CellValue | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || rowKey === null) return;
    setValue(null);
    setFetchError(null);
    setSaved(null);
    setOverwrite(false);
    setSavePath("");
    mutate(
      { handleId, object, column, key: rowKey },
      {
        onSuccess: (data) => setValue(data),
        onError: (error) => setFetchError(error instanceof Error ? error.message : String(error)),
      },
    );
  }, [visible, handleId, object, column, rowKey, mutate]);

  const bytes = useMemo(
    () => (value?.kind === "blob" && value.base64 ? fromBase64(value.base64) : null),
    [value],
  );
  const mime = bytes === null ? null : imageMime(bytes);
  const hex = bytes === null ? null : hexDump(bytes, HEX_PREVIEW_BYTES);
  const suggestedPath = useMemo(() => {
    if (rowKey === null) return "";
    const key = rowKey
      .map((part) => (part === null ? "null" : typeof part === "object" ? (part.kind === "blob" ? "blob" : part.value) : String(part)))
      .join("-");
    const extension = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : mime === "image/gif" ? "gif" : mime === "image/webp" ? "webp" : "bin";
    const separator = defaultDirectory.endsWith("/") || defaultDirectory.endsWith("\\") ? "" : "/";
    return `${defaultDirectory}${separator}${object}-${column}-${key}.${extension}`;
  }, [rowKey, defaultDirectory, object, column, mime]);

  function saveBytes() {
    if (rowKey === null || value?.kind !== "blob") return;
    const targetPath = savePath.trim().length > 0 ? savePath.trim() : suggestedPath;
    if (targetPath.length === 0) return;
    saveBlob.mutate(
      { handleId, object, column, key: rowKey, targetPath, overwrite },
      {
        onSuccess: (result) => {
          setSaved(result.path);
          toast.show(`Saved ${formatBytesForHumans(result.bytes)}.`);
        },
        onError: (error) => {
          const message = error instanceof Error ? error.message : String(error);
          if (/already exists/i.test(message)) setOverwrite(true);
        },
      },
    );
  }

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
      buttonPrimary: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.foreground, fontSize: 12 },
      image: { height: layout.compact ? 120 : 180, borderRadius: 6, backgroundColor: theme.colors.surface2 },
      saveRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      input: {
        flex: 1,
        paddingHorizontal: 8,
        paddingVertical: 6,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
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
                {mime !== null && value.truncated === false ? (
                  <Image
                    accessibilityLabel="Binary image preview"
                    source={{ uri: `data:${mime};base64,${value.base64 ?? ""}` }}
                    style={styles.image}
                    resizeMode="contain"
                  />
                ) : null}
                <ScrollView style={styles.block}>
                  <Text style={styles.mono}>{hex ?? ""}</Text>
                </ScrollView>
                <Text style={styles.note}>
                  {`Hex dump of the first ${formatBytesForHumans(Math.min(HEX_PREVIEW_BYTES, value.sizeBytes))}. Copy takes the full base64.`}
                </Text>
                <View style={styles.saveRow}>
                  <TextInput
                    value={savePath.length > 0 ? savePath : suggestedPath}
                    onChangeText={(text) => {
                      setSavePath(text);
                      setOverwrite(false);
                    }}
                    placeholder="Save as…"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    style={[styles.mono, styles.input]}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={overwrite ? "Overwrite the file" : "Save to file"}
                    style={[styles.button, styles.buttonPrimary]}
                    onPress={saveBytes}
                  >
                    <Text style={styles.buttonText}>{overwrite ? "Overwrite" : "Save"}</Text>
                  </Pressable>
                </View>
                {saved === null ? null : <Text style={styles.note}>{`Saved to ${saved}`}</Text>}
                {saveBlob.error === null ? null : (
                  <Text style={styles.error}>
                    {saveBlob.error instanceof Error ? saveBlob.error.message : String(saveBlob.error)}
                  </Text>
                )}
              </>
            ) : (
              <Text style={styles.mono}>NULL</Text>
            )}
          </>
        )}

        <View style={styles.actions}>
          {onEditRow === undefined ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Edit this row"
              style={[styles.button, styles.buttonPrimary]}
              onPress={onEditRow}
            >
              <Text style={styles.buttonText}>Edit row</Text>
            </Pressable>
          )}
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
