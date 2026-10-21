import type { Cell } from "./api";

export type CellTone = "value" | "muted" | "null" | "blob" | "number";

export interface CellDisplay {
  text: string;
  tone: CellTone;
  /** True when the value continues beyond what the grid shows. */
  clipped: boolean;
  title: string;
}

/** Bytes of a blob preview the grid shows before the ellipsis. */
const BLOB_PREVIEW_BYTES = 16;

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

/** How a cell reads inside the grid. */
export function displayCell(cell: Cell): CellDisplay {
  if (cell === null) return { text: "NULL", tone: "null", clipped: false, title: "NULL" };
  if (typeof cell === "number") {
    return { text: String(cell), tone: "number", clipped: false, title: String(cell) };
  }
  if (typeof cell === "string") {
    return {
      text: cell.replace(/\s+/g, " "),
      tone: cell.length === 0 ? "muted" : "value",
      clipped: false,
      title: cell.length === 0 ? "(empty string)" : cell,
    };
  }
  if (cell.kind === "bigint") {
    return { text: cell.value, tone: "number", clipped: false, title: cell.value };
  }
  if (cell.kind === "longtext") {
    return {
      text: cell.preview.replace(/\s+/g, " "),
      tone: "value",
      clipped: true,
      title: `${formatBytes(cell.size)} of text`,
    };
  }
  const preview = cell.previewHex.slice(0, BLOB_PREVIEW_BYTES * 2);
  return {
    text: preview.length > 0 ? `0x${preview}` : "BLOB",
    tone: "blob",
    clipped: true,
    title: `BLOB, ${formatBytes(cell.size)}`,
  };
}

export function describeCell(cell: Cell): string {
  if (cell === null) return "NULL";
  if (typeof cell === "string" || typeof cell === "number") return String(cell);
  if (cell.kind === "bigint") return cell.value;
  if (cell.kind === "longtext") return `${formatBytes(cell.size)} of text`;
  return `BLOB, ${formatBytes(cell.size)}`;
}

export function columnWidth(column: { name: string; declaredType: string; affinity: string }): number {
  const byName = column.name.length * 9 + 28;
  const base =
    column.affinity === "integer" || column.affinity === "real"
      ? 110
      : column.affinity === "blob"
        ? 150
        : 170;
  return Math.max(90, Math.min(280, Math.max(base, byName)));
}

export function formatBytesForHumans(size: number): string {
  return formatBytes(size);
}
