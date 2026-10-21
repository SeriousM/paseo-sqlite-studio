import { FlatList, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRows, type Cell, type Filter, type KeyValue, type Sort } from "./api";
import { FilterModal } from "./filter-modal";
import { RecordCards } from "./record-cards";
import { columnWidth, displayCell } from "./format";
import type { ViewerHost } from "./types";

export interface GridColumn {
  name: string;
  declaredType: string;
  affinity: string;
}

export interface CellTarget {
  column: string;
  key: KeyValue[];
  cell: Cell;
  /** The whole row, aligned with the grid's `columns`, for the row editor. */
  row: Cell[];
}

export interface DataGridProps extends ViewerHost {
  handleId: string;
  object: string;
  columns: GridColumn[];
  pageSize: number;
  filters: Filter[];
  onFiltersChange: (filters: Filter[]) => void;
  /** Owned by the parent so an export can reuse the same view of the data. */
  search: string;
  onSearchChange: (search: string) => void;
  sort: Sort[];
  onSortChange: (sort: Sort[]) => void;
  /** Bump to refetch after a write. */
  reloadKey: number;
  onOpenCell: (target: CellTarget) => void;
  /** Present when the database is writable; the grid then offers row actions. */
  onInsertRow?: (() => void) | undefined;
  onEditRow?: ((target: CellTarget) => void) | undefined;
  onExport?: (() => void) | undefined;
}

const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 34;
const GUTTER_WIDTH = 64;
const SEARCH_DEBOUNCE_MS = 250;

interface PageRef {
  cursor: KeyValue[] | null;
  offset: number;
}

export function DataGrid({
  theme,
  layout,
  handleId,
  object,
  columns,
  pageSize,
  filters,
  onFiltersChange,
  search,
  onSearchChange,
  sort,
  onSortChange,
  reloadKey,
  onOpenCell,
  onInsertRow,
  onEditRow,
  onExport,
}: DataGridProps) {
  const [query, setQuery] = useState("");
  const [countExact, setCountExact] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [pages, setPages] = useState<PageRef[]>([{ cursor: null, offset: 0 }]);
  const [pageIndex, setPageIndex] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPages([{ cursor: null, offset: 0 }]);
    setPageIndex(0);
    setCountExact(false);
  }, [object, query, sort, filters, reloadKey]);

  const page = pages[Math.min(pageIndex, pages.length - 1)] ?? { cursor: null, offset: 0 };
  const request = useMemo(
    () => ({
      object,
      limit: pageSize,
      cursor: page.cursor,
      offset: page.offset,
      sort,
      filters,
      search: query,
      countExact,
    }),
    [object, pageSize, page.cursor, page.offset, sort, filters, query, countExact, reloadKey],
  );

  const rowsQuery = useRows(handleId, request);
  const result = rowsQuery.data;
  const rows = result?.rows ?? [];
  const keys = result?.keys ?? [];

  const styles = useMemo(
    () => ({
      container: { flex: 1, backgroundColor: theme.colors.surface0 },
      toolbar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: layout.compact ? 8 : 12,
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      search: {
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
      status: { color: theme.colors.foregroundMuted, fontSize: 12 },
      button: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      buttonDisabled: { opacity: 0.4 },
      buttonActive: { borderColor: theme.colors.accent },
      chips: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 6,
        paddingHorizontal: layout.compact ? 8 : 12,
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      chip: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      chipText: { color: theme.colors.foreground, fontSize: 11 },
      buttonText: { color: theme.colors.foreground, fontSize: 12 },
      headerRow: {
        flexDirection: "row" as const,
        height: HEADER_HEIGHT,
        alignItems: "center" as const,
        backgroundColor: theme.colors.surface1,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      gutter: {
        width: GUTTER_WIDTH,
        paddingHorizontal: 8,
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        textAlign: "right" as const,
      },
      headerCell: {
        paddingHorizontal: 8,
        justifyContent: "center" as const,
        borderRightWidth: 1,
        borderRightColor: theme.colors.border,
        height: HEADER_HEIGHT,
      },
      headerName: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      headerType: { color: theme.colors.foregroundMuted, fontSize: 10 },
      row: { flexDirection: "row" as const, height: ROW_HEIGHT, alignItems: "center" as const },
      rowAlt: { backgroundColor: theme.colors.surface1 },
      cell: {
        paddingHorizontal: 8,
        borderRightWidth: 1,
        borderRightColor: theme.colors.border,
        height: ROW_HEIGHT,
        justifyContent: "center" as const,
      },
      cellText: { color: theme.colors.foreground, fontSize: 12 },
      cellMuted: { color: theme.colors.foregroundMuted, fontSize: 12, fontStyle: "italic" as const },
      cellNumber: { color: theme.colors.foreground, fontSize: 12, textAlign: "right" as const },
      cellBlob: { color: theme.colors.accent, fontSize: 12, fontFamily: "monospace" },
      cellNull: { color: theme.colors.foregroundMuted, fontSize: 12, fontStyle: "italic" as const },
      message: {
        padding: layout.compact ? 16 : 24,
        color: theme.colors.foregroundMuted,
        fontSize: 13,
      },
      error: { padding: layout.compact ? 16 : 24, color: theme.colors.statusDanger, fontSize: 13 },
    }),
    [theme, layout.compact],
  );

  const toneStyle = (tone: string) => {
    if (tone === "number") return styles.cellNumber;
    if (tone === "blob") return styles.cellBlob;
    if (tone === "null") return styles.cellNull;
    if (tone === "muted") return styles.cellMuted;
    return styles.cellText;
  };

  const widths = useMemo(() => columns.map((column) => columnWidth(column)), [columns]);
  const totalWidth = widths.reduce((sum, width) => sum + width, GUTTER_WIDTH);
  const sortDirection = (column: string) => sort.find((entry) => entry.column === column)?.direction ?? null;

  function toggleSort(column: string) {
    const current = sortDirection(column);
    if (current === null) onSortChange([{ column, direction: "asc" }]);
    else if (current === "asc") onSortChange([{ column, direction: "desc" }]);
    else onSortChange([]);
  }

  function goToNextPage() {
    if (!result?.hasMore) return;
    const next: PageRef = {
      cursor: result.nextCursor,
      offset: page.offset + pageSize,
    };
    setPages([...pages.slice(0, pageIndex + 1), next]);
    setPageIndex(pageIndex + 1);
  }

  const rangeStart = rows.length === 0 ? 0 : page.offset + 1;
  const rangeEnd = page.offset + rows.length;
  const statusText = result
    ? `Rows ${rangeStart}–${rangeEnd}${result.rowCount === null ? "" : ` of ${result.rowCount}`} · ${result.elapsedMs} ms`
    : "Loading…";

  if (layout.compact) {
    return (
      <RecordCards
        theme={theme}
        layout={layout}
        columns={columns}
        rows={rows}
        keys={keys}
        loading={rowsQuery.isPending}
        error={rowsQuery.error === null ? null : String(rowsQuery.error.message)}
        onOpenCell={onOpenCell}
      >
        <View style={styles.toolbar}>
          <TextInput
            value={search}
            onChangeText={onSearchChange}
            placeholder="Search all columns"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.search}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      </RecordCards>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <TextInput
          value={search}
          onChangeText={onSearchChange}
          placeholder="Search all columns"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.search}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={styles.status}>{statusText}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Edit filters"
          style={[styles.button, filters.length > 0 ? styles.buttonActive : null]}
          onPress={() => setFilterOpen(true)}
        >
          <Text style={styles.buttonText}>{filters.length > 0 ? `Filters (${filters.length})` : "Filters"}</Text>
        </Pressable>
        {onInsertRow ? (
          <Pressable accessibilityRole="button" style={styles.button} onPress={onInsertRow}>
            <Text style={styles.buttonText}>Add row</Text>
          </Pressable>
        ) : null}
        {onExport ? (
          <Pressable accessibilityRole="button" style={styles.button} onPress={onExport}>
            <Text style={styles.buttonText}>Export</Text>
          </Pressable>
        ) : null}
        {result && result.rowCount === null ? (
          <Pressable accessibilityRole="button" style={styles.button} onPress={() => setCountExact(true)}>
            <Text style={styles.buttonText}>Count all</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reload rows"
          style={styles.button}
          onPress={() => void rowsQuery.refetch()}
        >
          <Text style={styles.buttonText}>Reload</Text>
        </Pressable>
      </View>

      {filters.length === 0 ? null : (
        <View style={styles.chips}>
          {filters.map((filter, index) => (
            <Pressable
              key={`${filter.column}-${filter.operator}-${index}`}
              accessibilityRole="button"
              accessibilityLabel={`Remove filter on ${filter.column}`}
              style={styles.chip}
              onPress={() => onFiltersChange(filters.filter((_entry, position) => position !== index))}
            >
              <Text style={styles.chipText}>
                {filter.column} {filter.operator}
                {filter.value === undefined ? "" : ` ${filter.value}`}
              </Text>
              <Text style={styles.chipText}>×</Text>
            </Pressable>
          ))}
        </View>
      )}

      {rowsQuery.isError ? (
        <Text style={styles.error}>{String(rowsQuery.error.message)}</Text>
      ) : rows.length === 0 ? (
        <Text style={styles.message}>
          {rowsQuery.isPending ? "Loading…" : query.length > 0 ? "No rows match the search." : "This table has no rows."}
        </Text>
      ) : (
        <ScrollView horizontal contentContainerStyle={{ width: totalWidth }}>
          <View>
            <View style={styles.headerRow}>
              <Text style={[styles.gutter, { lineHeight: HEADER_HEIGHT }]}>#</Text>
              {columns.map((column, index) => {
                const direction = sortDirection(column.name);
                return (
                  <Pressable
                    key={column.name}
                    accessibilityRole="button"
                    accessibilityLabel={`Sort by ${column.name}`}
                    onPress={() => toggleSort(column.name)}
                    style={[styles.headerCell, { width: widths[index] ?? 160 }]}
                  >
                    <Text numberOfLines={1} style={styles.headerName}>
                      {column.name}
                      {direction === "asc" ? " ↑" : direction === "desc" ? " ↓" : ""}
                    </Text>
                    <Text numberOfLines={1} style={styles.headerType}>
                      {column.declaredType.length > 0 ? column.declaredType : column.affinity}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <FlatList
              data={rows}
              keyExtractor={(_row, index) => String(page.offset + index)}
              getItemLayout={(_data, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
              initialNumToRender={24}
              windowSize={9}
              removeClippedSubviews
              renderItem={({ item, index }) => (
                <View style={[styles.row, index % 2 === 1 ? styles.rowAlt : null]}>
                  {onEditRow ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Edit row ${page.offset + index + 1}`}
                      style={{ width: GUTTER_WIDTH }}
                      onPress={() =>
                        onEditRow({
                          column: columns[0]?.name ?? "",
                          key: keys[index] ?? [],
                          cell: item[0] ?? null,
                          row: item,
                        })
                      }
                    >
                      <Text style={[styles.gutter, { lineHeight: ROW_HEIGHT }]}>{page.offset + index + 1}</Text>
                    </Pressable>
                  ) : (
                    <Text style={[styles.gutter, { lineHeight: ROW_HEIGHT }]}>{page.offset + index + 1}</Text>
                  )}
                  {columns.map((column, columnIndex) => {
                    const cell = item[columnIndex] ?? null;
                    const display = displayCell(cell);
                    const rowKey = keys[index] ?? [];
                    return (
                      <Pressable
                        key={column.name}
                        accessibilityRole="button"
                        accessibilityLabel={`${column.name}: ${display.title}`}
                        onPress={() => onOpenCell({ column: column.name, key: rowKey, cell, row: item })}
                        style={[styles.cell, { width: widths[columnIndex] ?? 160 }]}
                      >
                        <Text numberOfLines={1} style={toneStyle(display.tone)}>
                          {display.clipped ? `${display.text}…` : display.text}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            />
          </View>
        </ScrollView>
      )}

      <FilterModal
        theme={theme}
        layout={layout}
        open={filterOpen}
        columns={columns}
        filters={filters}
        onApply={onFiltersChange}
        onClose={() => setFilterOpen(false)}
      />

      <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          disabled={pageIndex === 0}
          style={[styles.button, pageIndex === 0 ? styles.buttonDisabled : null]}
          onPress={() => setPageIndex(Math.max(0, pageIndex - 1))}
        >
          <Text style={styles.buttonText}>Previous</Text>
        </Pressable>
        <Text style={styles.status}>Page {pageIndex + 1}</Text>
        <Pressable
          accessibilityRole="button"
          disabled={!result?.hasMore}
          style={[styles.button, result?.hasMore ? null : styles.buttonDisabled]}
          onPress={goToNextPage}
        >
          <Text style={styles.buttonText}>Next</Text>
        </Pressable>
      </View>
    </View>
  );
}
