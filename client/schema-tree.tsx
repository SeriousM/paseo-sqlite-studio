import { FlatList, TextInput } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ObjectSummary } from "./api";
import type { ViewerHost } from "./types";

export interface SchemaTreeProps extends ViewerHost {
  objects: ObjectSummary[];
  selected: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (name: string) => void;
}

const GROUPS = [
  { kind: "table", title: "Tables" },
  { kind: "view", title: "Views" },
  { kind: "virtual-table", title: "Virtual tables" },
  { kind: "index", title: "Indexes" },
  { kind: "trigger", title: "Triggers" },
] as const satisfies readonly { kind: ObjectSummary["kind"]; title: string }[];

type TreeRow =
  | { key: string; type: "header"; title: string; count: number }
  | { key: string; type: "object" | "shadow"; name: string }
  | { key: string; type: "toggle"; parent: string; count: number; expanded: boolean };

export function SchemaTree({ theme, layout, objects, selected, loading, error, onSelect }: SchemaTreeProps) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const query = search.trim().toLowerCase();

  const rows = useMemo(() => {
    const matches = (name: string) => query.length === 0 || name.toLowerCase().includes(query);
    const shadowsByParent = new Map<string, ObjectSummary[]>();
    for (const object of objects) {
      if (object.kind !== "shadow-table" || object.parentName === null) continue;
      const siblings = shadowsByParent.get(object.parentName);
      if (siblings === undefined) shadowsByParent.set(object.parentName, [object]);
      else siblings.push(object);
    }

    const listed: TreeRow[] = [];
    for (const group of GROUPS) {
      const items = objects.filter((object) => {
        if (object.kind !== group.kind) return false;
        if (matches(object.name)) return true;
        if (group.kind !== "virtual-table") return false;
        return (shadowsByParent.get(object.name) ?? []).some((shadow) => matches(shadow.name));
      });
      if (items.length === 0) continue;

      listed.push({ key: `header:${group.kind}`, type: "header", title: group.title, count: items.length });
      for (const object of items) {
        listed.push({ key: `object:${object.name}`, type: "object", name: object.name });
        if (group.kind !== "virtual-table") continue;

        const shadows = (shadowsByParent.get(object.name) ?? []).filter(
          (shadow) => matches(object.name) || matches(shadow.name),
        );
        if (shadows.length === 0) continue;

        const open = expanded.includes(object.name);
        listed.push({
          key: `toggle:${object.name}`,
          type: "toggle",
          parent: object.name,
          count: shadows.length,
          expanded: open,
        });
        if (!open) continue;
        for (const shadow of shadows) {
          listed.push({ key: `shadow:${shadow.name}`, type: "shadow", name: shadow.name });
        }
      }
    }
    return listed;
  }, [objects, query, expanded]);

  const styles = useMemo(
    () => ({
      container: { flex: 1, backgroundColor: theme.colors.surface0 },
      toolbar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
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
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: layout.compact ? 8 : 12,
        paddingVertical: 4,
        backgroundColor: theme.colors.surface1,
      },
      headerTitle: {
        flex: 1,
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "600" as const,
        textTransform: "uppercase" as const,
      },
      headerCount: { color: theme.colors.foregroundMuted, fontSize: 11 },
      row: {
        paddingHorizontal: layout.compact ? 8 : 12,
        paddingVertical: layout.compact ? 7 : 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      rowSelected: { backgroundColor: theme.colors.accent },
      rowText: { color: theme.colors.foreground, fontSize: 13 },
      rowTextSelected: { color: theme.colors.accentForeground, fontSize: 13, fontWeight: "600" as const },
      shadowRow: { paddingLeft: layout.compact ? 24 : 32 },
      shadowText: { color: theme.colors.foregroundMuted, fontSize: 12 },
      toggleRow: {
        paddingLeft: layout.compact ? 24 : 32,
        paddingRight: layout.compact ? 8 : 12,
        paddingVertical: 6,
      },
      toggleText: { color: theme.colors.accent, fontSize: 12 },
      message: {
        padding: layout.compact ? 16 : 24,
        color: theme.colors.foregroundMuted,
        fontSize: 13,
      },
      error: { padding: layout.compact ? 16 : 24, color: theme.colors.statusDanger, fontSize: 13 },
    }),
    [theme, layout.compact],
  );

  function toggleShadow(parent: string) {
    setExpanded(
      expanded.includes(parent) ? expanded.filter((name) => name !== parent) : [...expanded, parent],
    );
  }

  const status =
    error !== null ? (
      <Text style={styles.error}>{error}</Text>
    ) : loading ? (
      <Text style={styles.message}>Loading…</Text>
    ) : rows.length === 0 ? (
      <Text style={styles.message}>
        {query.length > 0 ? "No objects match" : "This database has no objects."}
      </Text>
    ) : null;

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search objects"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.search}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {status ?? (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.key}
          initialNumToRender={32}
          windowSize={9}
          removeClippedSubviews
          renderItem={({ item }) => {
            if (item.type === "header") {
              return (
                <View style={styles.header}>
                  <Text style={styles.headerTitle}>{item.title}</Text>
                  <Text style={styles.headerCount}>{item.count}</Text>
                </View>
              );
            }
            if (item.type === "toggle") {
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${item.expanded ? "Hide" : "Show"} internal tables of ${item.parent}`}
                  style={styles.toggleRow}
                  onPress={() => toggleShadow(item.parent)}
                >
                  <Text style={styles.toggleText}>
                    {item.expanded ? "▾" : "▸"} {item.count} internal tables
                  </Text>
                </Pressable>
              );
            }
            const isSelected = item.name === selected;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${item.name}`}
                style={[
                  styles.row,
                  item.type === "shadow" ? styles.shadowRow : null,
                  isSelected ? styles.rowSelected : null,
                ]}
                onPress={() => onSelect(item.name)}
              >
                <Text
                  numberOfLines={1}
                  style={
                    isSelected
                      ? styles.rowTextSelected
                      : item.type === "shadow"
                        ? styles.shadowText
                        : styles.rowText
                  }
                >
                  {item.name}
                </Text>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}
