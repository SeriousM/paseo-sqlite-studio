import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useOpenDatabase, type OpenedDatabase } from "./api";
import { DatabaseView } from "./database-view";
import type { ViewerSurface } from "./types";

/**
 * The host hands a file panel the path on the daemon that owns it, so the
 * database is opened where it lives: nothing but query results crosses the wire.
 */
export interface SqliteFilePanelProps extends ViewerSurface {
  file: { path: string; name: string };
  pageSize?: number;
}

export function SqliteFilePanel({ theme, layout, host, file, pageSize }: SqliteFilePanelProps) {
  const openDatabase = useOpenDatabase();
  const [database, setDatabase] = useState<OpenedDatabase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lockOffer, setLockOffer] = useState<string | null>(null);
  const openedPathRef = useRef<string | null>(null);

  const open = useCallback(
    async (mode: "direct" | "snapshot") => {
      setError(null);
      setLockOffer(null);
      try {
        const result = await openDatabase.mutateAsync({ path: file.path, mode });
        if (result.ok) {
          setDatabase(result);
          return;
        }
        setError(result.error.message);
        if (result.error.canSnapshot && mode === "direct") setLockOffer(result.error.message);
      } catch (openError) {
        setError(openError instanceof Error ? openError.message : String(openError));
      }
    },
    [file.path, openDatabase],
  );

  useEffect(() => {
    const target = `${host.id}:${file.path}`;
    if (openedPathRef.current === target) return;
    openedPathRef.current = target;
    setDatabase(null);
    void open("direct");
  }, [file.path, host.id, open]);

  const styles = useMemo(
    () => ({
      root: {
        flex: 1,
        gap: 10,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      title: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      body: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
      warning: { color: theme.colors.statusWarning, fontSize: 13 },
      button: {
        alignSelf: "flex-start" as const,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      buttonText: { color: theme.colors.accentForeground, fontSize: 13 },
    }),
    [theme, layout.compact],
  );

  if (database !== null) {
    return (
      <DatabaseView
        key={`${host.id}:${database.handleId}`}
        theme={theme}
        layout={layout}
        hostId={host.id}
        handleId={database.handleId}
        database={database}
        pageSize={pageSize ?? 200}
      />
    );
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>{file.name}</Text>
      <Text style={styles.body}>{file.path}</Text>
      {error === null ? <Text style={styles.body}>Opening database…</Text> : <Text style={styles.error}>{error}</Text>}
      {lockOffer === null ? null : (
        <>
          <Text style={styles.warning}>
            Another process holds this database. A snapshot copy is read-only and may miss the newest changes.
          </Text>
          <Pressable accessibilityRole="button" style={styles.button} onPress={() => void open("snapshot")}>
            <Text style={styles.buttonText}>Open snapshot copy</Text>
          </Pressable>
        </>
      )}
      {error !== null && lockOffer === null ? (
        <Pressable accessibilityRole="button" style={styles.button} onPress={() => void open("direct")}>
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
