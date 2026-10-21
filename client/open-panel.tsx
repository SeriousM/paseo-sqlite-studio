import { ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { DirectoryListing } from "./api";
import { formatBytesForHumans } from "./format";
import type { ViewerHost } from "./types";

/**
 * Where a database is chosen: a path you can type, a server-side browser, and
 * the paths opened before. The browser runs next to the file, so the panel never
 * needs local filesystem access of its own.
 */
export interface OpenPanelProps extends ViewerHost {
  recents: string[];
  path: string;
  onPathChange: (path: string) => void;
  busy: boolean;
  error: string | null;
  lockOffer: { path: string; message: string } | null;
  directory: DirectoryListing | null;
  directoryLoading: boolean;
  directoryError: string | null;
  onBrowse: (path: string) => void;
  onOpen: (path: string, mode: "direct" | "snapshot") => void;
  onForget: (path: string) => void;
}

export function OpenPanel({
  theme,
  layout,
  recents,
  path,
  onPathChange,
  busy,
  error,
  lockOffer,
  directory,
  directoryLoading,
  directoryError,
  onBrowse,
  onOpen,
  onForget,
}: OpenPanelProps) {
  const styles = useMemo(
    () => ({
      root: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 12 : 16, gap: 10 },
      title: { color: theme.colors.foreground, fontSize: 16, fontWeight: "600" as const },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      input: {
        flex: 1,
        minWidth: 120,
        paddingHorizontal: 10,
        paddingVertical: layout.compact ? 6 : 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        color: theme.colors.foreground,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      button: {
        paddingHorizontal: 12,
        paddingVertical: layout.compact ? 6 : 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      buttonDisabled: { opacity: 0.4 },
      buttonText: { color: theme.colors.foreground, fontSize: 12 },
      warningCard: {
        padding: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.statusWarning,
        backgroundColor: theme.colors.surface1,
        gap: 6,
      },
      warningText: { color: theme.colors.statusWarning, fontSize: 12 },
      sectionTitle: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const, marginTop: 6 },
      browseRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      browseName: { color: theme.colors.foreground, fontSize: 13, flexShrink: 1 },
      browseDirectory: { color: theme.colors.accent, fontSize: 13, flexShrink: 1 },
      browseParent: { color: theme.colors.foregroundMuted, fontSize: 13 },
      browseSize: { color: theme.colors.foregroundMuted, fontSize: 11 },
      recentPath: { color: theme.colors.foreground, fontSize: 12, flexShrink: 1 },
      recentPathPressable: { flexGrow: 1, flexShrink: 1 },
      message: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
    }),
    [theme, layout.compact],
  );

  const entries = useMemo(() => {
    const listed = directory?.entries ?? [];
    return [...listed].sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }, [directory]);

  const parentPath = directory?.parentPath ?? null;

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Open a SQLite database</Text>

        <View style={styles.row}>
          <TextInput
            value={path}
            onChangeText={onPathChange}
            placeholder="/path/to/database.sqlite3"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open the database at this path"
            disabled={busy}
            style={[styles.button, busy ? styles.buttonDisabled : null]}
            onPress={() => onOpen(path, "direct")}
          >
            <Text style={styles.buttonText}>{busy ? "Opening…" : "Open"}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Browse this directory"
            style={styles.button}
            onPress={() => onBrowse(path)}
          >
            <Text style={styles.buttonText}>Browse</Text>
          </Pressable>
        </View>

        {error !== null ? <Text style={styles.error}>{error}</Text> : null}

        {lockOffer === null ? null : (
          <View style={styles.warningCard}>
            <Text style={styles.warningText}>{lockOffer.message}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open a snapshot copy"
              disabled={busy}
              style={[styles.button, busy ? styles.buttonDisabled : null]}
              onPress={() => onOpen(lockOffer.path, "snapshot")}
            >
              <Text style={styles.buttonText}>Open snapshot copy</Text>
            </Pressable>
          </View>
        )}

        {directoryError !== null ? (
          <Text style={styles.error}>{directoryError}</Text>
        ) : directoryLoading ? (
          <Text style={styles.message}>Loading…</Text>
        ) : directory === null ? null : (
          <View>
            {parentPath === null ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Parent directory"
                style={styles.browseRow}
                onPress={() => onBrowse(parentPath)}
              >
                <Text style={styles.browseParent}>..</Text>
              </Pressable>
            )}
            {entries.length === 0 ? (
              <Text style={styles.message}>No database files here</Text>
            ) : (
              entries.map((entry) => (
                <Pressable
                  key={entry.path}
                  accessibilityRole="button"
                  accessibilityLabel={`${entry.isDirectory ? "Directory" : "File"} ${entry.name}`}
                  style={styles.browseRow}
                  onPress={() =>
                    entry.isDirectory ? onBrowse(entry.path) : onOpen(entry.path, "direct")
                  }
                >
                  <Text numberOfLines={1} style={entry.isDirectory ? styles.browseDirectory : styles.browseName}>
                    {entry.isDirectory ? `${entry.name}/` : entry.name}
                  </Text>
                  {entry.isDirectory ? null : (
                    <Text style={styles.browseSize}>{formatBytesForHumans(entry.sizeBytes)}</Text>
                  )}
                </Pressable>
              ))
            )}
            {directory.truncated ? (
              <Text style={styles.message}>Only the first entries in this directory are listed.</Text>
            ) : null}
          </View>
        )}

        {recents.length === 0 ? null : (
          <View>
            <Text style={styles.sectionTitle}>Recents</Text>
            {recents.map((recent) => (
              <View key={recent} style={styles.browseRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${recent}`}
                  style={styles.recentPathPressable}
                  onPress={() => onOpen(recent, "direct")}
                >
                  <Text numberOfLines={1} style={styles.recentPath}>
                    {recent}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Forget ${recent}`}
                  style={styles.button}
                  onPress={() => onForget(recent)}
                >
                  <Text style={styles.buttonText}>Forget</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
