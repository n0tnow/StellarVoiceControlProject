import { useCallback, useState } from "react";

/** First 8 + last 8 characters, so a wrong hash is visible without the noise. */
export function fingerprint(hash: string): string {
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

/**
 * The short payload-hash fingerprint, revealed behind the card's "Details"
 * toggle. The full hash is copied on click (best effort — clipboard access may
 * be unavailable in a webview, in which case the title still exposes it).
 */
export function HashFingerprint({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard === undefined) return;
    navigator.clipboard
      .writeText(hash)
      .then(() => setCopied(true))
      .catch(() => {});
  }, [hash]);

  return (
    <button
      type="button"
      onClick={onCopy}
      title={hash}
      aria-label={`Copy full payload hash ${hash}`}
      className="flex w-full items-center justify-between gap-2 rounded-md border border-polaris-line bg-black/20 px-2 py-1 text-left transition-colors hover:bg-white/5"
    >
      <span className="selectable font-mono text-[11px] text-polaris-text">
        {fingerprint(hash)}
      </span>
      <span className="text-[10px] uppercase tracking-wide text-polaris-muted">
        {copied ? "Copied" : "Copy"}
      </span>
    </button>
  );
}
