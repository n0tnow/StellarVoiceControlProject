/**
 * Anchor explain records → History rows (HISTORY-UI).
 *
 * The anchor lane is session-scoped and optional: `getAnchorSession()` throws
 * until `configureAnchor` ran, so an unconfigured build simply yields no anchor
 * rows. Read-only; the explain log holds no secret.
 */
import type { HistoryRow } from "./model.ts";
import { anchorToHistoryRow } from "./model.ts";

/** The current session's value-moving explain records as History rows. */
export async function loadAnchorRows(): Promise<HistoryRow[]> {
  try {
    const { anchor } = await import("@polaris/stellar");
    const rows: HistoryRow[] = [];
    for (const record of anchor.getAnchorSession().explain.all()) {
      const row = anchorToHistoryRow(record);
      if (row) rows.push(row);
    }
    return rows;
  } catch {
    return [];
  }
}
