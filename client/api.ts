import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { useEffect, useRef, useState } from "react";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { z } from "zod";
import type {
  cellSchema,
  filterSchema,
  keyValueSchema,
  rowQueryResultSchema,
  sortSchema,
  sqliteOpenResultSchema,
  writeValueSchema,
  columnAssignmentSchema,
} from "../shared/contracts";
import {
  cancelJob,
  closeDatabase,
  deleteRow,
  enableWriting,
  insertRow,
  listDirectory,
  openDatabase,
  readCell,
  readObject,
  readStats,
  saveBlob,
  pollJob,
  readRows,
  readSchema,
  startJob,
  updateRow,
} from "../shared/contracts";

export type Cell = z.infer<typeof cellSchema>;
export type KeyValue = z.infer<typeof keyValueSchema>;
export type RowQueryResult = z.infer<typeof rowQueryResultSchema>;
export type OpenResult = z.infer<typeof sqliteOpenResultSchema>;
export type Filter = z.infer<typeof filterSchema>;
export type Sort = z.infer<typeof sortSchema>;
export type OpenedDatabase = Extract<OpenResult, { ok: true }>;

export type SchemaResult = RpcOutput<typeof readSchema>;
export type ObjectSummary = SchemaResult["objects"][number];
export type ObjectDetail = RpcOutput<typeof readObject>;
export type ColumnMeta = ObjectDetail["columns"][number];
export type DirectoryListing = RpcOutput<typeof listDirectory>;
export type CellValue = RpcOutput<typeof readCell>;
export type DatabaseInfo = OpenedDatabase["info"];
export type ColumnStats = RpcOutput<typeof readStats>;
export type JobStatus = RpcOutput<typeof pollJob>;
export type JobResult = NonNullable<JobStatus["result"]>;
export type JobRequest = RpcInput<typeof startJob>;
export type WriteValue = z.infer<typeof writeValueSchema>;
export type ColumnAssignment = z.infer<typeof columnAssignmentSchema>;

export interface RowRequest {
  object: string;
  limit: number;
  offset?: number;
  cursor?: KeyValue[] | null;
  sort?: Sort[];
  filters?: Filter[];
  search?: string;
  columns?: string[];
  countExact?: boolean;
}

export function useOpenDatabase() {
  const open = useRpc(openDatabase);
  return useMutation({ mutationFn: (input: { path: string; mode?: "direct" | "snapshot" }) => open(input) });
}

export function useCloseDatabase() {
  const close = useRpc(closeDatabase);
  return useMutation({ mutationFn: (handleId: string) => close({ handleId }) });
}

export function useDirectory(hostId: string, path: string | null) {
  const list = useRpc(listDirectory);
  return useQuery({
    queryKey: ["sqlite", hostId, "directory", path],
    enabled: path !== null && path.length > 0,
    queryFn: () => list({ path: path ?? "" }),
  });
}

export function useSchema(hostId: string, handleId: string | null) {
  const schema = useRpc(readSchema);
  return useQuery({
    queryKey: ["sqlite", hostId, "schema", handleId],
    enabled: handleId !== null,
    queryFn: () => schema({ handleId: handleId ?? "" }),
  });
}

export function useObjectDetail(hostId: string, handleId: string | null, name: string | null) {
  const read = useRpc(readObject);
  return useQuery({
    queryKey: ["sqlite", hostId, "object", handleId, name],
    enabled: handleId !== null && name !== null,
    queryFn: () => read({ handleId: handleId ?? "", name: name ?? "" }),
  });
}

export function useRows(hostId: string, handleId: string | null, request: RowRequest, enabled = true) {
  const rows = useRpc(readRows);
  return useQuery({
    queryKey: ["sqlite", hostId, "rows", handleId, request],
    enabled: handleId !== null && enabled,
    queryFn: () => rows({ handleId: handleId ?? "", ...request }),
    // Row data changes on disk, not on a schedule: refetch only when asked.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60 * 1000,
  });
}

export function useCellValue() {
  const cell = useRpc(readCell);
  return useMutation({
    mutationFn: (input: { handleId: string; object: string; column: string; key: KeyValue[] }) => cell(input),
  });
}

/** Polling cadence while a job runs; fast enough to feel live, cheap enough to ignore. */
const JOB_POLL_MS = 400;

export interface JobRunner {
  status: JobStatus | null;
  running: boolean;
  start: (input: JobRequest) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
}

/** Starts a daemon-side job and polls it until it settles. */
export function useJobRunner(): JobRunner {
  const startJobRpc = useRpc(startJob);
  const pollJobRpc = useRpc(pollJob);
  const cancelJobRpc = useRpc(cancelJob);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const jobIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (status?.state !== "running") return;
    const jobId = jobIdRef.current;
    if (jobId === null) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void pollJobRpc({ jobId })
        .then((next) => {
          if (!cancelled) setStatus(next);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setStatus({
            jobId,
            kind: status.kind,
            state: "failed",
            startedAt: status.startedAt,
            elapsedMs: status.elapsedMs,
            result: null,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }, JOB_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollJobRpc, status]);

  return {
    status,
    running: status?.state === "running",
    async start(input) {
      setStatus(null);
      try {
        const { jobId } = await startJobRpc(input);
        jobIdRef.current = jobId;
        setStatus({
          jobId,
          kind: input.kind,
          state: "running",
          startedAt: Date.now(),
          elapsedMs: 0,
          result: null,
          error: null,
        });
      } catch (error) {
        setStatus({
          jobId: "",
          kind: input.kind,
          state: "failed",
          startedAt: Date.now(),
          elapsedMs: 0,
          result: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    async cancel() {
      const jobId = jobIdRef.current;
      if (jobId === null) return;
      await cancelJobRpc({ jobId });
      setStatus(await pollJobRpc({ jobId }));
    },
    reset() {
      jobIdRef.current = null;
      setStatus(null);
    },
  };
}

export function useSetWriting() {
  const setWriting = useRpc(enableWriting);
  return useMutation({
    mutationFn: (input: { handleId: string; enabled: boolean }) => setWriting(input),
  });
}

export function useInsertRow() {
  const insert = useRpc(insertRow);
  return useMutation({
    mutationFn: (input: { handleId: string; object: string; values: ColumnAssignment[] }) => insert(input),
  });
}

export function useUpdateRow() {
  const update = useRpc(updateRow);
  return useMutation({
    mutationFn: (input: {
      handleId: string;
      object: string;
      key: KeyValue[];
      changes: ColumnAssignment[];
      expected?: ColumnAssignment[];
    }) => update(input),
  });
}

export function useDeleteRow() {
  const remove = useRpc(deleteRow);
  return useMutation({
    mutationFn: (input: {
      handleId: string;
      object: string;
      key: KeyValue[];
      expected?: ColumnAssignment[];
    }) => remove(input),
  });
}

/** Aggregates for one column over the current filters, computed on the daemon. */
export function useColumnStats(
  hostId: string,
  handleId: string,
  request: { object: string; column: string; filters: Filter[]; search: string },
  enabled: boolean,
) {
  const stats = useRpc(readStats);
  return useQuery({
    queryKey: ["sqlite", hostId, "stats", handleId, request],
    enabled: enabled && handleId.length > 0 && request.column.length > 0 && request.object.length > 0,
    queryFn: () =>
      stats({
        handleId,
        object: request.object,
        column: request.column,
        filters: request.filters,
        search: request.search,
      }),
  });
}

export function useSaveBlob() {
  const save = useRpc(saveBlob);
  return useMutation({
    mutationFn: (input: {
      handleId: string;
      object: string;
      column: string;
      key: KeyValue[];
      targetPath: string;
      overwrite?: boolean;
    }) => save(input),
  });
}

export interface WorkspaceStart {
  name: string;
  directory: string;
}

/**
 * Recent workspaces on this host, used as starting points for the file browser.
 * Recency is the workspace's own activity timestamp, not ours.
 */
export function useWorkspaceStarts(hostId: string, limit = 6) {
  const paseo = usePaseo();
  return useQuery({
    queryKey: ["sqlite", hostId, "workspaces", limit],
    queryFn: async (): Promise<WorkspaceStart[]> => {
      const result = await paseo.workspaces.list();
      const seen = new Set<string>();
      const starts: Array<WorkspaceStart & { activityAt: string }> = [];
      for (const workspace of result.entries) {
        if (workspace.background === true) continue;
        if (workspace.archivingAt) continue;
        const directory = workspace.workspaceDirectory ?? workspace.projectRootPath;
        if (!directory || seen.has(directory)) continue;
        seen.add(directory);
        starts.push({
          name: workspace.title ?? workspace.name,
          directory,
          activityAt: workspace.activityAt ?? "",
        });
      }
      return starts
        .sort((left, right) => right.activityAt.localeCompare(left.activityAt))
        .slice(0, limit)
        .map(({ name, directory }) => ({ name, directory }));
    },
    staleTime: 30_000,
  });
}
