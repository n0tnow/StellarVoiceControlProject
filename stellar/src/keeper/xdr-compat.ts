/**
 * Tiny accessors for walking XDR values across @stellar/stellar-sdk versions.
 *
 * SDK >= 17 exposes XDR unions as plain objects (`value.type === "txFailed"`,
 * fields as properties); older SDKs use `value.switch().name` and accessor
 * methods (`value.result()`). The keeper only *reads* a few result fields for
 * error classification, so a compat reader keeps that code independent of
 * which major the monorepo happens to pin.
 */
type Loose = Record<string, unknown>;

/** Read `o.name` whether it is a property (new SDK) or a zero-arg method (old SDK). */
export function field(o: unknown, name: string): unknown {
  if (o === null || typeof o !== "object") return undefined;
  const v = (o as Loose)[name];
  return typeof v === "function" ? (v as () => unknown).call(o) : v;
}

/** Variant name of an XDR union value (`"txBadSeq"`, `"scvError"`, ...). */
export function variant(o: unknown): string | undefined {
  if (o === null || typeof o !== "object") return undefined;
  const t = (o as Loose).type;
  if (typeof t === "string") return t;
  const sw = (o as Loose).switch;
  if (typeof sw === "function") {
    const s = (sw as () => unknown).call(o);
    const name = field(s, "name");
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
