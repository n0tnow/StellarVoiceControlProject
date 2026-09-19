/**
 * Throwaway key management for the live run.
 *
 * Secrets live ONLY here, in `~/.polaris-e2e/keys.json` (dir `0700`, file
 * `0600`). Nothing else in the repo is read: not `~/.config/stellar`, not the
 * `stellar` CLI keystore, not any `.env`. Callers print public keys only.
 *
 * Hardening (review COR-2 + non-blocking #4/#5):
 *   - permissions are repaired on load, but never *through* a symlink
 *     (`lstat` guard) so a symlinked key path cannot chmod its target;
 *   - writes are atomic: a `0600` temp file in the same directory is written,
 *     `fsync`ed and renamed over the destination, so a crash cannot truncate
 *     the previous `keys.json`.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";

export type KeyRole = "owner" | "executor" | "recipient" | "issuer" | "keeper";
export const KEY_ROLES: readonly KeyRole[] = ["owner", "executor", "recipient", "issuer", "keeper"];

export interface KeyMaterial {
  public: string;
  secret: string;
}

export interface AssetRecord {
  code: string;
  issuer: string;
  /** Deployed Stellar Asset Contract id (C...). */
  sac: string;
}

export interface KeysFile {
  version: 1;
  network: "testnet";
  createdAt: string;
  keys: Record<KeyRole, KeyMaterial>;
  asset?: AssetRecord;
}

export interface LoadKeysOptions {
  reset?: boolean;
  /** Sink for permission-repair warnings (tests inject). Defaults to stderr. */
  warn?: (message: string) => void;
}

const SECRET_RE = /^S[A-Z2-7]{55}$/;
const PUBLIC_RE = /^G[A-Z2-7]{55}$/;

/** Generate one fresh keypair. */
export function generateKey(): KeyMaterial {
  const kp = Keypair.random();
  return { public: kp.publicKey(), secret: kp.secret() };
}

/**
 * Load the key file, or generate a complete fresh set. `reset: true` always
 * regenerates (dropping the previous asset record) so a run can start clean.
 */
export function loadOrCreateKeys(path: string, opts: LoadKeysOptions = {}): KeysFile {
  if (!opts.reset && existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as KeysFile;
    validateKeys(parsed);
    // Review COR-2: repair (and fail loudly on) wrong permissions on load, not
    // just on write, so a pre-existing `keys.json` can never stay world-readable.
    repairPermissions(path, opts.warn);
    return parsed;
  }
  const file = newKeysFile();
  writeKeys(path, file);
  return file;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function warnToStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Enforce dir `0700` / file `0600`; throws if either cannot be repaired.
 *
 * A symlinked file or directory is never chmodded (review non-blocking #4):
 * following the link would silently change the permissions of whatever it
 * points at, so we skip with a warning instead.
 */
export function repairPermissions(path: string, warn: (message: string) => void = warnToStderr): void {
  const dir = dirname(path);
  if (isSymlink(path)) {
    warn(`refusing to repair permissions through a symlinked keys file: ${path}`);
    return;
  }
  if (isSymlink(dir)) {
    warn(`refusing to chmod a symlinked keys directory: ${dir}`);
  } else {
    chmodSync(dir, 0o700);
  }
  chmodSync(path, 0o600);
}

export function newKeysFile(now: () => Date = () => new Date()): KeysFile {
  const keys = {} as Record<KeyRole, KeyMaterial>;
  for (const role of KEY_ROLES) keys[role] = generateKey();
  return { version: 1, network: "testnet", createdAt: now().toISOString(), keys };
}

/**
 * Atomically persist with the required permissions, creating the directory as
 * needed. The JSON is written to a `0600` temp file in the same directory,
 * `fsync`ed, then renamed over the destination (review non-blocking #5).
 */
export function writeKeys(path: string, file: KeysFile): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!isSymlink(dir)) chmodSync(dir, 0o700);
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(file, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best effort cleanup; the original error is the one that matters.
    }
    throw e;
  }
  chmodSync(path, 0o600);
}

export function keypairOf(file: KeysFile, role: KeyRole): Keypair {
  return Keypair.fromSecret(file.keys[role].secret);
}

export function publicKeyOf(file: KeysFile, role: KeyRole): string {
  return file.keys[role].public;
}

/** `{ owner: "G...", ... }` — public addresses only, for reports. */
export function publicAddresses(file: KeysFile): Record<KeyRole, string> {
  return Object.fromEntries(KEY_ROLES.map((role) => [role, file.keys[role].public])) as Record<KeyRole, string>;
}

function validateKeys(file: KeysFile): void {
  if (file.network !== "testnet") throw new Error(`key file is not testnet (${String(file.network)})`);
  for (const role of KEY_ROLES) {
    const material = file.keys?.[role];
    if (!material || !SECRET_RE.test(material.secret) || !PUBLIC_RE.test(material.public)) {
      throw new Error(`key file is missing a valid ${role} key; re-run with --reset`);
    }
  }
}
