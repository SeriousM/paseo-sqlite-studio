import type { Cell, KeyValue } from "./contracts";

/**
 * Cell and key encoding, kept free of runtime APIs on purpose: the daemon embeds
 * these exact functions into a worker script through `Function.prototype.toString`,
 * so a job worker encodes values identically to the plugin thread.
 */

export const MAX_TEXT_CHARS = 4096;
export const MAX_BLOB_PREVIEW_BYTES = 64;
export const MAX_KEY_BYTES = 1024;
export const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
export const MIN_SAFE_INTEGER = BigInt(Number.MIN_SAFE_INTEGER);

const HEX_DIGITS = "0123456789abcdef";
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toHex(bytes: Uint8Array, limit: number): string {
  let out = "";
  const end = Math.min(bytes.length, limit);
  for (let index = 0; index < end; index += 1) {
    const byte = bytes[index] ?? 0;
    out += HEX_DIGITS[byte >> 4] ?? "0";
    out += HEX_DIGITS[byte & 15] ?? "0";
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    out += BASE64_ALPHABET[first >> 2] ?? "A";
    out += BASE64_ALPHABET[((first & 3) << 4) | (second >> 4)] ?? "A";
    out += index + 1 < bytes.length ? (BASE64_ALPHABET[((second & 15) << 2) | (third >> 6)] ?? "A") : "=";
    out += index + 2 < bytes.length ? (BASE64_ALPHABET[third & 63] ?? "A") : "=";
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let byteIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (const character of clean) {
    const value = BASE64_ALPHABET.indexOf(character);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[byteIndex] = (buffer >> bits) & 0xff;
      byteIndex += 1;
    }
  }
  return bytes.subarray(0, byteIndex);
}

/** SQLite's affinity rules, applied to a declared type. */
export function affinityOf(declaredType: string): "integer" | "real" | "text" | "blob" | "numeric" {
  const upper = declaredType.toUpperCase();
  if (upper.includes("INT")) return "integer";
  if (upper.includes("CHAR") || upper.includes("CLOB") || upper.includes("TEXT")) return "text";
  if (upper.includes("BLOB") || upper.length === 0) return "blob";
  if (upper.includes("REAL") || upper.includes("FLOA") || upper.includes("DOUB")) return "real";
  return "numeric";
}

export function isSafeInteger(value: bigint): boolean {
  return value >= MIN_SAFE_INTEGER && value <= MAX_SAFE_INTEGER;
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
      previewHex: toHex(value.subarray(0, MAX_BLOB_PREVIEW_BYTES), MAX_BLOB_PREVIEW_BYTES),
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
    return { kind: "blob", base64: toBase64(value) };
  }
  return String(value);
}

export function decodeKey(value: KeyValue): string | number | bigint | Uint8Array | null {
  if (value === null) return null;
  if (typeof value === "number" || typeof value === "string") return value;
  if (value.kind === "bigint") return BigInt(value.value);
  return fromBase64(value.base64);
}

/** SQLite bind parameters accept only these value shapes. */
export type BindValue = null | number | bigint | string | Uint8Array;

export function bindValue(value: KeyValue): BindValue {
  return decodeKey(value);
}

/** Source of the pure helpers, embedded verbatim into worker scripts. */
export function encodingPrologue(): string {
  return [
    `const MAX_TEXT_CHARS = ${MAX_TEXT_CHARS};`,
    `const MAX_BLOB_PREVIEW_BYTES = ${MAX_BLOB_PREVIEW_BYTES};`,
    `const MAX_KEY_BYTES = ${MAX_KEY_BYTES};`,
    `const MAX_SAFE_INTEGER = BigInt(${Number.MAX_SAFE_INTEGER});`,
    `const MIN_SAFE_INTEGER = BigInt(${Number.MIN_SAFE_INTEGER});`,
    `const HEX_DIGITS = ${JSON.stringify(HEX_DIGITS)};`,
    `const BASE64_ALPHABET = ${JSON.stringify(BASE64_ALPHABET)};`,
    toHex.toString(),
    affinityOf.toString(),
    toBase64.toString(),
    isSafeInteger.toString(),
    encodeCell.toString(),
    encodeKey.toString(),
  ].join("\n");
}
