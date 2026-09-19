/**
 * Off-chain alias book (docs/confidential-payments.md §12 C3).
 *
 * The recipient of a payment is resolved ONLY through this book. An
 * agent-supplied raw `G...` address is refused even when it matches a known
 * alias's address — strkeys are never dictated by voice and never passed
 * through unchecked (docs/interfaces.md §6; slice analysis §H.6).
 *
 * Pure and browser-safe: it imports `StrKey` (a pure helper) but no Node
 * globals, no `fs`, no `Buffer`.
 */
import { StrKey } from "@stellar/stellar-sdk";

/** Alias names are lowercase and start with a letter (C3). */
const ALIAS_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Names that would collide with `Object.prototype` members. The book uses a
 * null prototype and `resolveAlias` only reads own properties, but a reserved
 * name here is refused explicitly so a typo can never become a silent lookup.
 */
const RESERVED_ALIAS_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export interface AliasEntry {
  address: string;
  network: "testnet";
  /** Confidential Tokens registration state (docs/confidential-payments.md §7). */
  ctRegistered?: boolean;
  /** Stellar Private Payments readiness state. */
  sppReady?: boolean;
}

export type AliasBook = Record<string, AliasEntry>;

export interface ParsedAliasBook {
  book: AliasBook;
  /** Non-fatal findings, e.g. two aliases resolving to the same address. */
  warnings: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a `aliases.json` value (object or JSON string) into an `AliasBook`.
 * Throws on a malformed alias name, a bad G-address checksum or a non-testnet
 * entry. Address collisions are allowed but returned as warnings.
 */
export function parseAliasBook(input: unknown): ParsedAliasBook {
  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (e) {
      throw new Error(`aliases.json is not valid JSON: ${(e as Error).message}`);
    }
  }
  if (!isPlainObject(raw)) throw new Error("alias book must be a JSON object of { alias: entry }");

  const book: AliasBook = Object.create(null);
  for (const [name, value] of Object.entries(raw)) {
    if (RESERVED_ALIAS_NAMES.has(name)) {
      throw new Error(`alias name ${JSON.stringify(name)} is reserved and cannot be used`);
    }
    if (!ALIAS_NAME.test(name)) {
      throw new Error(`alias name ${JSON.stringify(name)} must match [a-z][a-z0-9_-]{0,31}`);
    }
    if (!isPlainObject(value)) throw new Error(`alias ${name} must be an object`);
    const address = value.address;
    if (typeof address !== "string" || !StrKey.isValidEd25519PublicKey(address)) {
      throw new Error(`alias ${name} has an invalid Stellar address (expected a G... strkey)`);
    }
    if (value.network !== "testnet") {
      throw new Error(`alias ${name} must be on "testnet", got ${JSON.stringify(value.network)}`);
    }
    const entry: AliasEntry = { address, network: "testnet" };
    if (value.ctRegistered !== undefined) {
      if (typeof value.ctRegistered !== "boolean") throw new Error(`alias ${name}.ctRegistered must be a boolean`);
      entry.ctRegistered = value.ctRegistered;
    }
    if (value.sppReady !== undefined) {
      if (typeof value.sppReady !== "boolean") throw new Error(`alias ${name}.sppReady must be a boolean`);
      entry.sppReady = value.sppReady;
    }
    book[name] = entry;
  }
  return { book, warnings: findAliasCollisions(book) };
}

/**
 * Case-insensitive, trimmed lookup. Returns undefined for anything not a known
 * alias name. Only OWN properties are read, so `Object.prototype` members
 * (`constructor`, `toString`, …) can never leak through as a resolved entry.
 */
export function resolveAlias(book: AliasBook, name: string): AliasEntry | undefined {
  if (typeof name !== "string") return undefined;
  const key = name.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(book, key) ? book[key] : undefined;
}

/** Human-readable warnings for aliases that share one address (allowed by C3). */
export function findAliasCollisions(book: AliasBook): string[] {
  const byAddress = new Map<string, string[]>();
  for (const [name, entry] of Object.entries(book)) {
    const names = byAddress.get(entry.address) ?? [];
    names.push(name);
    byAddress.set(entry.address, names);
  }
  const warnings: string[] = [];
  for (const [address, names] of byAddress) {
    if (names.length > 1) warnings.push(`${names.join(", ")} all resolve to ${address}`);
  }
  return warnings;
}
