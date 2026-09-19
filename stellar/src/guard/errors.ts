/**
 * Typed errors for the guard client.
 *
 * The names and kinds are **not re-declared here**: they are read from
 * `keeper/errors.ts`, the single table that is already drift-checked against
 * `contracts/polaris_guard/src/lib.rs`. This keeps the guard client and the
 * keeper from disagreeing about what `Error(Contract, #105)` means.
 *
 * A simulation failure is surfaced as a `GuardClientError` carrying the mapped
 * name/kind/code — never as a raw host string alone.
 */
import {
  GUARD_ERROR_BASE,
  GUARD_ERRORS,
  TOKEN_ERRORS,
  classifyContractText,
  classifyThrown,
  type ClassifiedError,
  type ErrorKind,
  type GuardErrorDef,
} from "../keeper/errors.ts";

export { GUARD_ERRORS, TOKEN_ERRORS, GUARD_ERROR_BASE };
export type { ErrorKind, GuardErrorDef };

/** Guard error codes (100..116) -> name, for callers that only want the name. */
export const GUARD_ERROR_NAMES: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(Object.entries(GUARD_ERRORS).map(([code, def]) => [Number(code), def.name])),
);

/** Built-in SAC/token error codes (<100) -> name. */
export const TOKEN_ERROR_NAMES: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(Object.entries(TOKEN_ERRORS).map(([code, def]) => [Number(code), def.name])),
);

export interface GuardClientErrorInit {
  name: string;
  kind: ErrorKind;
  message: string;
  /** Contract error code when one was found. */
  code?: number;
}

/** Machine-readable guard failure. Match on `name`/`kind`/`code`, never `message`. */
export class GuardClientError extends Error {
  /** Contract error code when one was decoded from a simulation failure. */
  readonly code: number | undefined;
  readonly kind: ErrorKind;

  constructor(init: GuardClientErrorInit) {
    super(init.message);
    this.name = init.name;
    this.kind = init.kind;
    this.code = init.code;
  }
}

export function isGuardClientError(value: unknown): value is GuardClientError {
  return value instanceof GuardClientError;
}

/** Wrap a `keeper/errors.ts` classification as a typed guard error. */
export function guardErrorFromClassified(classified: ClassifiedError): GuardClientError {
  return new GuardClientError({
    name: classified.name,
    kind: classified.kind,
    message: classified.message,
    code: classified.code,
  });
}

/**
 * Build a typed error from a bare contract error code. Codes >= 100 are guard
 * policy; below that they came from the token (SAC) or the host, exactly as
 * `keeper/errors.ts` documents.
 */
export function guardErrorFromCode(code: number, message?: string): GuardClientError {
  const def = (code >= GUARD_ERROR_BASE ? GUARD_ERRORS : TOKEN_ERRORS)[code];
  if (def) {
    return new GuardClientError({
      name: def.name,
      kind: def.kind,
      code,
      message: message ?? `contract error #${code} (${def.name})`,
    });
  }
  return new GuardClientError({
    name: `ContractError#${code}`,
    kind: "unknown_contract",
    code,
    message: message ?? `unrecognised contract error #${code}`,
  });
}

/** Classify a Soroban simulation error string (`sim.error`) as a typed error. */
export function classifyGuardText(text: string): GuardClientError {
  return guardErrorFromClassified(classifyContractText(text));
}

/** Coerce any thrown value into a typed guard error (transport -> `rpc` kind). */
export function asGuardClientError(error: unknown): GuardClientError {
  if (isGuardClientError(error)) return error;
  return guardErrorFromClassified(classifyThrown(error));
}
