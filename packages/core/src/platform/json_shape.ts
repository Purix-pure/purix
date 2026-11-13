// src/platform/json_shape.ts
//
// H1: JSON that comes from outside (a provider's reply, an audit tool's output, a file in the project) has no promised shape.
// These readers give an empty value for a wrong type, so the code after them never throws a TypeError on `null`, a string where an object
// was expected, or a number where text was. They validate nothing beyond the top-level type: callers still check each field they use.

export type JsonObject = Record<string, unknown>;

/** The value when it is a plain object, else `{}` (an array is not a plain object here). */
export function asObject(v: unknown): JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as JsonObject) : {};
}

/** The value when it is an array, else `[]`. */
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** The value when it is a non-empty string, else `fallback`. */
export function asText(v: unknown, fallback: string): string {
  return typeof v === "string" && v !== "" ? v : fallback;
}
