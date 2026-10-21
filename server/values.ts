import type { Cell, KeyValue } from "../shared/contracts";

/** Long text and blobs travel as previews; `sqlite.cell` fetches the full value. */
export const MAX_TEXT_CHARS = 4096;
export const MAX_BLOB_PREVIEW_BYTES = 64;
export const MAX_KEY_BYTES = 1024;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

function isSafeInteger(value: bigint): boolean {
  return value >= MIN_SAFE && value <= MAX_SAFE;
}

export function encodeCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (value.length <= MAX_TEXT_CHARS) return value;
    return { kind: "longtext", size: value.length, preview: value.slice(0, MAX_TEXT_CHARS) };
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") {
    return isSafeInteger(value) ? Number(value) : { kind: "bigint", value: value.toString() };
  }
  if (value instanceof Uint8Array) {
    return {
      kind: "blob",
      size: value.byteLength,
      previewHex: Buffer.from(value.subarray(0, MAX_BLOB_PREVIEW_BYTES)).toString("hex"),
    };
  }
  return String(value);
}

export function encodeKey(value: unknown): KeyValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") {
    return isSafeInteger(value) ? Number(value) : { kind: "bigint", value: value.toString() };
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_KEY_BYTES) {
      throw new Error(
        `A row key of ${value.byteLength} bytes is too large to address. This table cannot be paged by key.`,
      );
    }
    return { kind: "blob", base64: Buffer.from(value).toString("base64") };
  }
  return String(value);
}

export function decodeKey(value: KeyValue): string | number | bigint | Uint8Array | null {
  if (value === null) return null;
  if (typeof value === "number" || typeof value === "string") return value;
  if (value.kind === "bigint") return BigInt(value.value);
  return new Uint8Array(Buffer.from(value.base64, "base64"));
}

/** SQLite bind parameters accept only these value shapes. */
export type BindValue = null | number | bigint | string | Uint8Array;

export function bindValue(value: KeyValue): BindValue {
  return decodeKey(value);
}
