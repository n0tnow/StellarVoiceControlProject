/**
 * A block-explorer link that opens in the default browser through the
 * allow-listed `open_external` command (the notch itself never navigates).
 * Renders as a small text button so it sits inline in any row.
 */
import { ExternalLink } from "lucide-react";

import { openExternal } from "@/lib/app";
import { explorerAccountUrl, explorerTxUrl, DEFAULT_EXPLORER_BASE } from "@/lib/history";

export interface ExplorerLinkProps {
  /** A transaction hash or an account address; `kind` says which. */
  target: string;
  kind: "tx" | "account";
  label?: string;
  /** Render just the icon, as a `page-icon-button`-styled control. */
  iconOnly?: boolean;
}

export function ExplorerLink({ target, kind, label, iconOnly = false }: ExplorerLinkProps) {
  const url =
    kind === "tx"
      ? explorerTxUrl(DEFAULT_EXPLORER_BASE, target)
      : explorerAccountUrl(DEFAULT_EXPLORER_BASE, target);
  if (url === null) return null;
  const onClick = (): void => {
    void openExternal(url).catch((error: unknown) => console.warn("open explorer failed", error));
  };
  if (iconOnly) {
    const accessible = label ?? (kind === "tx" ? "View on explorer" : "Open account in explorer");
    return (
      <button
        type="button"
        className="page-icon-button"
        onClick={onClick}
        aria-label={accessible}
        title={accessible}
      >
        <ExternalLink aria-hidden="true" />
      </button>
    );
  }
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-[11px] text-[var(--color-notch-accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-notch-accent)]"
      onClick={onClick}
    >
      <ExternalLink aria-hidden="true" className="h-3 w-3" />
      {label ?? "View on explorer"}
    </button>
  );
}
