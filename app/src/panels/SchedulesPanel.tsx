import { useState } from "react";
import type { Intent } from "@polaris/interfaces";

import { PanelShell } from "@/panels/PanelShell";
import { Button } from "@/components/ui/button";
import { KeeperStrip } from "@/panels/schedules/KeeperStrip";
import { NewScheduleForm } from "@/panels/schedules/NewScheduleForm";
import { ScheduleList } from "@/panels/schedules/ScheduleList";
import { useSchedules } from "@/panels/schedules/useSchedules";
import { buildScheduleForm, type ScheduleForm, type ScheduleRow } from "@/lib/schedules";
import { cancelChainTool, scheduleChainTool } from "@/lib/schedulesLive";
import { useTxRun } from "@/lib/useTxRun";

/**
 * "Upcoming payments" panel (W6b).
 *
 * Lists the owner's on-chain schedules (next run local **and** UTC) with a
 * Cancel button, and a New-schedule form. Every create/cancel is an unsigned
 * XDR built by `@polaris/stellar` and pushed through the shared
 * `useTxRun`/`runTx` pipeline (Touch ID → Freighter → submit); this panel never
 * signs, never holds a key and never starts the keeper.
 */
export function SchedulesPanel() {
  const { rows, loading, error, timeZone, refresh } = useSchedules();
  const tx = useTxRun();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const running = tx.state === "running";

  const cancel = async (row: ScheduleRow) => {
    setBusyId(row.id);
    setActionError(null);
    const intent: Intent = {
      kind: "cancel_schedule",
      asset: "",
      amount: "",
      scheduleId: row.id,
      source: "schedules panel",
    };
    try {
      const result = await cancelChainTool(intent);
      const [outcome] = await tx.run([{ result, intent, label: `Cancel schedule #${row.id}` }]);
      if (outcome?.status === "submitted") refresh();
      else setActionError(outcome?.detail ?? "The cancellation was not submitted.");
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusyId(null);
    }
  };

  const create = async (form: ScheduleForm) => {
    setActionError(null);
    const built = buildScheduleForm(form);
    if (!built.ok) {
      setActionError(built.error);
      return;
    }
    try {
      const result = await scheduleChainTool(built.intent);
      const [outcome] = await tx.run([
        { result, intent: built.intent, label: `Schedule ${form.amount} ${form.asset} to ${form.recipient}` },
      ]);
      if (outcome?.status === "submitted") refresh();
      else setActionError(outcome?.detail ?? "The schedule was not created.");
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const last = tx.outcomes[tx.outcomes.length - 1];

  return (
    <PanelShell title="Schedules" subtitle="Upcoming payments · testnet">
      <div className="space-y-4">
        <KeeperStrip rows={rows} />

        {error ? (
          <p className="rounded-lg border border-polaris-danger/40 bg-polaris-danger/10 px-3 py-2 text-xs text-polaris-text">
            {error}
          </p>
        ) : null}
        {actionError ? <p className="text-xs text-polaris-danger">{actionError}</p> : null}
        {running && tx.progress ? (
          <p className="text-xs text-polaris-muted">
            {tx.progress.label} — {tx.progress.phase}…
          </p>
        ) : last && last.status !== "submitted" ? (
          <p className="text-xs text-polaris-muted">{last.detail}</p>
        ) : null}

        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Upcoming</h2>
          <Button size="sm" variant="ghost" sound={false} onClick={refresh} disabled={running || loading}>
            Refresh
          </Button>
        </div>
        <ScheduleList rows={rows} loading={loading} busyId={busyId} onCancel={(row) => void cancel(row)} />

        <NewScheduleForm disabled={running} timeZone={timeZone} onCreate={(form) => void create(form)} />
      </div>
    </PanelShell>
  );
}
