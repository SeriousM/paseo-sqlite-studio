import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { ObjectDetail } from "./api";
import type { ViewerHost } from "./types";

export interface StructureViewProps extends ViewerHost {
  detail: ObjectDetail | null;
  loading: boolean;
  error: string | null;
}

type DetailColumn = ObjectDetail["columns"][number];

const LABEL_WIDTH = 180;

function columnBadges(column: DetailColumn): string[] {
  const badges: string[] = [];
  if (column.primaryKeyPosition > 0) badges.push("PK");
  if (column.notNull) badges.push("NOT NULL");
  if (column.unique) badges.push("unique");
  if (column.hidden === "generated-stored") badges.push("generated (stored)");
  else if (column.hidden === "generated-dynamic") badges.push("generated (dynamic)");
  else if (column.hidden === "virtual") badges.push("hidden");
  return badges;
}

export function StructureView({ theme, layout, detail, loading, error }: StructureViewProps) {
  const styles = useMemo(
    () => ({
      container: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 12 : 16, gap: 12 },
      titleRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        flexWrap: "wrap" as const,
        gap: 8,
      },
      title: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      flag: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
        color: theme.colors.foregroundMuted,
        fontSize: 10,
        fontWeight: "600" as const,
      },
      subtitle: { color: theme.colors.foregroundMuted, fontSize: 12 },
      section: { gap: 2 },
      sectionTitle: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "600" as const,
        textTransform: "uppercase" as const,
      },
      entry: {
        flexDirection: "row" as const,
        alignItems: "flex-start" as const,
        gap: 8,
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      entryCompact: {
        flexDirection: "column" as const,
        gap: 4,
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      label: { width: LABEL_WIDTH, color: theme.colors.foreground, fontSize: 13 },
      labelCompact: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      value: {
        flex: 1,
        flexDirection: "row" as const,
        alignItems: "center" as const,
        flexWrap: "wrap" as const,
        gap: 6,
      },
      valueCompact: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        flexWrap: "wrap" as const,
        gap: 6,
      },
      valueText: { color: theme.colors.foreground, fontSize: 12 },
      metaText: { color: theme.colors.foregroundMuted, fontSize: 11 },
      badge: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
        color: theme.colors.foregroundMuted,
        fontSize: 10,
        fontWeight: "600" as const,
      },
      none: { color: theme.colors.foregroundMuted, fontSize: 12, paddingVertical: 6 },
      sqlBlock: {
        padding: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      sql: { color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" },
      sqlMuted: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        fontFamily: "monospace",
        fontStyle: "italic" as const,
      },
      message: {
        padding: layout.compact ? 16 : 24,
        color: theme.colors.foregroundMuted,
        fontSize: 13,
      },
      error: { padding: layout.compact ? 16 : 24, color: theme.colors.statusDanger, fontSize: 13 },
    }),
    [theme, layout.compact],
  );

  if (error !== null) return <Text style={styles.error}>{error}</Text>;
  if (loading) return <Text style={styles.message}>Loading…</Text>;
  if (detail === null) return <Text style={styles.message}>Select a table to inspect it</Text>;

  const tabular =
    detail.kind === "table" ||
    detail.kind === "view" ||
    detail.kind === "virtual-table" ||
    detail.kind === "shadow-table";
  const entryStyle = layout.compact ? styles.entryCompact : styles.entry;
  const labelStyle = layout.compact ? styles.labelCompact : styles.label;
  const valueStyle = layout.compact ? styles.valueCompact : styles.value;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{detail.name}</Text>
          {detail.withoutRowId ? <Text style={styles.flag}>WITHOUT ROWID</Text> : null}
          {detail.strict ? <Text style={styles.flag}>STRICT</Text> : null}
        </View>
        {detail.parentName === null ? null : <Text style={styles.subtitle}>{detail.parentName}</Text>}
      </View>

      {tabular ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Columns</Text>
          {detail.columns.length === 0 ? (
            <Text style={styles.none}>None</Text>
          ) : (
            detail.columns.map((column) => (
              <View key={column.name} style={entryStyle}>
                <Text numberOfLines={1} style={labelStyle}>
                  {column.name}
                </Text>
                <View style={valueStyle}>
                  <Text style={styles.valueText}>
                    {column.declaredType.length > 0 ? column.declaredType : column.affinity}
                  </Text>
                  {columnBadges(column).map((badge) => (
                    <Text key={badge} style={styles.badge}>
                      {badge}
                    </Text>
                  ))}
                  {column.defaultValue === null ? null : (
                    <Text style={styles.metaText}>{`default ${column.defaultValue}`}</Text>
                  )}
                </View>
              </View>
            ))
          )}
        </View>
      ) : null}

      {tabular ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Indexes</Text>
          {detail.indexes.length === 0 ? (
            <Text style={styles.none}>None</Text>
          ) : (
            detail.indexes.map((index) => (
              <View key={index.name} style={entryStyle}>
                <Text numberOfLines={1} style={labelStyle}>
                  {index.name}
                </Text>
                <View style={valueStyle}>
                  <Text style={styles.valueText}>
                    {index.columns.length === 0 ? "(expression)" : index.columns.join(", ")}
                  </Text>
                  {index.unique ? <Text style={styles.badge}>unique</Text> : null}
                  {index.partial ? <Text style={styles.badge}>partial</Text> : null}
                  <Text style={styles.metaText}>{index.origin}</Text>
                </View>
              </View>
            ))
          )}
        </View>
      ) : null}

      {tabular ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Foreign keys</Text>
          {detail.foreignKeys.length === 0 ? (
            <Text style={styles.none}>None</Text>
          ) : (
            detail.foreignKeys.map((key) => {
              const target = key.toColumn === null ? key.toTable : `${key.toTable}.${key.toColumn}`;
              return (
                <View key={`${key.id}:${key.fromColumn}`} style={entryStyle}>
                  <Text numberOfLines={1} style={labelStyle}>
                    {key.fromColumn}
                  </Text>
                  <View style={valueStyle}>
                    <Text style={styles.valueText}>{`→ ${target}`}</Text>
                    {key.onUpdate === "NO ACTION" ? null : (
                      <Text style={styles.metaText}>{`on update ${key.onUpdate}`}</Text>
                    )}
                    {key.onDelete === "NO ACTION" ? null : (
                      <Text style={styles.metaText}>{`on delete ${key.onDelete}`}</Text>
                    )}
                  </View>
                </View>
              );
            })
          )}
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>DDL</Text>
        <View style={styles.sqlBlock}>
          <Text selectable style={detail.sql === null ? styles.sqlMuted : styles.sql}>
            {detail.sql ?? "No DDL recorded."}
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}
