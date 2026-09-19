/**
 * Node-only alias-book loader. Kept in its own file so the pure modules
 * (`aliases.ts`, `summary.ts`, `sendPayment.ts`) stay browser-safe.
 */
import { readFileSync } from "node:fs";
import { parseAliasBook, type ParsedAliasBook } from "./aliases.ts";

/** Reads and validates a committed `aliases.json` file. */
export function loadAliasBook(path: string): ParsedAliasBook {
  return parseAliasBook(readFileSync(path, "utf8"));
}
