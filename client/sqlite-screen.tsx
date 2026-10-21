import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { viewerSettings } from "../shared/settings";
import { useDirectory, useOpenDatabase, type OpenedDatabase } from "./api";
import { DatabaseView } from "./database-view";
import { OpenPanel } from "./open-panel";

const MAX_RECENTS = 12;

function directoryOf(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator > 0 ? path.slice(0, separator) : path;
}

export function SqliteScreen({ theme, layout, host, params }: PluginScreenProps) {
  const settings = useSettings(viewerSettings);
  const ready = settings.status === "ready";
  const values = ready ? settings.values : null;
  const revision = ready ? settings.revision : null;

  const [database, setDatabase] = useState<OpenedDatabase | null>(null);
  const [path, setPath] = useState(params.path ?? "");
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lockOffer, setLockOffer] = useState<{ path: string; message: string } | null>(null);
  const [autoOpened, setAutoOpened] = useState(false);

  const openDatabase = useOpenDatabase();
  const directory = useDirectory(host.id, browsePath);

  const pageSize = values?.pageSize ?? 200;
  const recents = values?.recentPaths ?? [];

  const remember = useCallback(
    (opened: string) => {
      if (!ready || values === null || revision === null) return;
      const nextRecents = [opened, ...values.recentPaths.filter((entry) => entry !== opened)].slice(0, MAX_RECENTS);
      void settings.save(
        { ...values, recentPaths: nextRecents, lastDirectory: directoryOf(opened) },
        revision,
      );
    },
    [ready, revision, settings, values],
  );

  const open = useCallback(
    async (target: string, mode: "direct" | "snapshot" = "direct") => {
      setError(null);
      setLockOffer(null);
      try {
        const result = await openDatabase.mutateAsync({ path: target, mode });
        if (result.ok) {
          setDatabase(result);
          setPath(target);
          remember(target);
          return;
        }
        setError(result.error.message);
        if (result.error.canSnapshot && mode === "direct") {
          setLockOffer({ path: target, message: result.error.message });
        }
      } catch (openError) {
        setError(openError instanceof Error ? openError.message : String(openError));
      }
    },
    [openDatabase, remember],
  );

  // Paseo shows one screen for every connected daemon and switches the host in the
  // header, so a host change abandons the database opened on the previous host.
  useEffect(() => {
    setDatabase(null);
    setError(null);
    setLockOffer(null);
    setBrowsePath(null);
  }, [host.id]);

  const initialPath = params.path ?? "";
  const autoOpenRef = useRef(false);
  useEffect(() => {
    if (autoOpenRef.current || autoOpened) return;
    if (initialPath.length === 0) return;
    autoOpenRef.current = true;
    setAutoOpened(true);
    void open(initialPath, "direct");
  }, [autoOpened, initialPath, open]);

  useEffect(() => {
    if (browsePath !== null || database !== null || values === null) return;
    const start = values.lastDirectory.length > 0 ? values.lastDirectory : directoryOf(path);
    if (start.length > 0) setBrowsePath(start);
  }, [browsePath, database, path, values]);

  const styles = useMemo(
    () => ({
      root: { flex: 1, backgroundColor: theme.colors.surface0 },
      error: { padding: 12, color: theme.colors.statusDanger, fontSize: 12 },
    }),
    [theme],
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
        pageSize={pageSize}
        onClose={() => {
          setDatabase(null);
          setError(null);
        }}
      />
    );
  }

  return (
    <View style={styles.root}>
      <OpenPanel
        theme={theme}
        layout={layout}
        recents={recents}
        path={path}
        onPathChange={setPath}
        busy={openDatabase.isPending}
        error={error}
        lockOffer={lockOffer}
        directory={directory.data ?? null}
        directoryLoading={directory.isPending && browsePath !== null}
        directoryError={directory.error === null ? null : String(directory.error.message)}
        onBrowse={(target) => setBrowsePath(target)}
        onOpen={(target, mode) => void open(target, mode)}
        onForget={(target) => {
          if (values === null || revision === null) return;
          void settings.save(
            { ...values, recentPaths: values.recentPaths.filter((entry) => entry !== target) },
            revision,
          );
        }}
      />
      {settings.status === "invalid" ? (
        <Text style={styles.error}>Stored viewer settings are invalid: {settings.error}</Text>
      ) : null}
    </View>
  );
}
