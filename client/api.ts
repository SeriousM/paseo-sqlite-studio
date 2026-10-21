import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { z } from "zod";
import type {
  cellSchema,
  filterSchema,
  keyValueSchema,
  rowQueryResultSchema,
  sortSchema,
  sqliteOpenResultSchema,
} from "../shared/contracts";
import {
  closeDatabase,
  listDirectory,
  openDatabase,
  readCell,
  readObject,
  readRows,
  readSchema,
  runQuery,
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
export type DirectoryListing = RpcOutput<typeof listDirectory>;
export type CellValue = RpcOutput<typeof readCell>;
export type QueryResult = RpcOutput<typeof runQuery>;
export type DatabaseInfo = OpenedDatabase["info"];

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

export function useDirectory(path: string | null) {
  const list = useRpc(listDirectory);
  return useQuery({
    queryKey: ["sqlite", "directory", path],
    enabled: path !== null && path.length > 0,
    queryFn: () => list({ path: path ?? "" }),
  });
}

export function useSchema(handleId: string | null) {
  const schema = useRpc(readSchema);
  return useQuery({
    queryKey: ["sqlite", "schema", handleId],
    enabled: handleId !== null,
    queryFn: () => schema({ handleId: handleId ?? "" }),
  });
}

export function useObjectDetail(handleId: string | null, name: string | null) {
  const read = useRpc(readObject);
  return useQuery({
    queryKey: ["sqlite", "object", handleId, name],
    enabled: handleId !== null && name !== null,
    queryFn: () => read({ handleId: handleId ?? "", name: name ?? "" }),
  });
}

export function useRows(handleId: string | null, request: RowRequest, enabled = true) {
  const rows = useRpc(readRows);
  return useQuery({
    queryKey: ["sqlite", "rows", handleId, request],
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

export function useRunQuery() {
  const query = useRpc(runQuery);
  return useMutation({
    mutationFn: (input: { handleId: string; sql: string; limit?: number }) => query(input),
  });
}
