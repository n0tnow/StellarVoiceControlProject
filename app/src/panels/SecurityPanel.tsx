import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { PanelNote, PanelShell } from "@/panels/PanelShell";
import { useTxRun } from "@/lib/useTxRun";
import type { TxRunOutcome } from "@/lib/txPipeline";
import {
  DEFAULT_LIMITS,
  effectiveFields,
  formatAmount,
  mergeAliasLines,
  stateLines,
  type AliasInput,
  type LimitsFields,
  type PlanStep,
  type ProfileMode,
  type SecurityAction,
  type SecurityState,
} from "@/lib/guardState.ts";
import {
  loadSecurityState,
  planBaseline,
  planDisable,
  planEnable,
  planSetAliases,
  planTighten,
  type BuiltPlan,
} from "@/lib/guardStateLive.ts";
import { AliasEditor } from "./security/AliasEditor.tsx";
import { ProfileForm } from "./security/ProfileForm.tsx";

/** Load lifecycle for the on-chain state. */
type Loaded =
  | { kind: "loading" }
  | { kind: "ok"; state: SecurityState }
  | { kind: "unconfigured"; detail: string }
  | { kind: "unreachable"; detail: string };

/**
 * Security & rules panel (W6a).
 *
 * Shows the owner's current on-chain rule set and lets the owner set it up,
 * enable/change/disable auto-pay and edit the alias book. Every on-chain write
 * goes through the shared `useTxRun` pipeline (approval card → Touch ID →
 * Freighter → submit); this panel only builds unsigned steps and renders
 * progress. It never signs, never holds a key and never enables
 * `POLARIS_ALLOW_AUTO_APPROVE`.
 */
export function SecurityPanel() {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [mode, setMode] = useState<ProfileMode>("always_ask");
  const [fields, setFields] = useState<LimitsFields>(DEFAULT_LIMITS);
  const [executor, setExecutor] = useState("");
  const [revokeAllowance, setRevokeAllowance] = useState(false);
  const [plan, setPlan] = useState<BuiltPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [savedAliases, setSavedAliases] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const tx = useTxRun();

  const refresh = useCallback(async () => {
    setLoaded({ kind: "loading" });
    const next = await loadSecurityState();
    setLoaded(next);
    if (next.kind === "ok") {
      setMode(next.state.executor && (next.state.rule?.auto_approve_limit ?? 0n) > 0n ? "auto_under_limit" : "always_ask");
      const rule = next.state.rule;
      if (rule) {
        setFields((current) => ({
          ...current,
          threshold: formatAmount(rule.auto_approve_limit),
          perTx: formatAmount(rule.per_tx_limit),
          daily: formatAmount(rule.daily_limit),
          knownRecipientsOnly: rule.known_recipients_only,
        }));
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const state = loaded.kind === "ok" ? loaded.state : null;
  const lines = useMemo(() => (state ? stateLines(state) : []), [state]);
  const aliases = useMemo(
    () => (state ? mergeAliasLines(state.aliases, savedAliases) : []),
    [state, savedAliases],
  );

  /** Build the plan for an action, run it, and stop if it cannot be built. */
  const buildPlan = useCallback(
    async (build: () => Promise<BuiltPlan>): Promise<TxRunOutcome[]> => {
      // In-flight guard: the plan build awaits before `tx.state` turns running,
      // so a fast double click could otherwise start two sequences.
      if (busyRef.current) return [];
      busyRef.current = true;
      setBusy(true);
      setPlan(null);
      setPlanError(null);
      tx.reset();
      try {
        const next = await build();
        setPlan(next);
        if (next.steps.length > 0) {
          const outcomes = await tx.run(next.steps as PlanStep[]);
          await refresh();
          return outcomes;
        }
        return [];
      } catch (error) {
        setPlanError(error instanceof Error ? error.message : String(error));
        return [];
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [refresh, tx],
  );

  const onAction = useCallback(
    (action: SecurityAction) => {
      if (!state) return;
      const effective = effectiveFields(mode, fields);
      if (action === "baseline") {
        void buildPlan(() => planBaseline(effective, state));
        return;
      }
      if (action === "enable") void buildPlan(() => planEnable(effective, executor.trim(), state));
      if (action === "tighten") void buildPlan(() => planTighten(effective, state));
      if (action === "disable") void buildPlan(() => planDisable(revokeAllowance, state));
    },
    [buildPlan, executor, fields, mode, revokeAllowance, state],
  );

  const onSaveAliases = useCallback(
    (entries: AliasInput[]) => {
      if (!state) return;
      void buildPlan(() => planSetAliases(entries, state)).then((outcomes) => {
        // Only names whose step actually submitted join the on-chain book.
        const saved = entries.filter((_entry, index) => outcomes[index]?.status === "submitted");
        if (saved.length > 0) {
          setSavedAliases((previous) =>
            Object.fromEntries([...Object.entries(previous), ...saved.map((e) => [e.alias, e.address])]),
          );
        }
      });
    },
    [buildPlan, state],
  );

  const running = busy || tx.state === "running";

  return (
    <PanelShell
      title="Security & rules"
      subtitle={state ? `Owner ${state.owner.slice(0, 6)}…${state.owner.slice(-4)}` : undefined}
    >
      <div className="space-y-4">
        {loaded.kind === "loading" ? <p className="text-xs text-polaris-muted">Reading on-chain state…</p> : null}
        {loaded.kind === "unconfigured" ? <PanelNote>Not set up: {loaded.detail}</PanelNote> : null}
        {loaded.kind === "unreachable" ? (
          <PanelNote>Could not reach the network: {loaded.detail}</PanelNote>
        ) : null}

        {state ? (
          <>
            <section className="space-y-2 rounded-lg border border-polaris-line bg-polaris-panel/60 p-3">
              <header className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Current on-chain state</h2>
                <Button size="sm" variant="ghost" sound={false} disabled={running} onClick={() => void refresh()}>
                  Refresh
                </Button>
              </header>
              <dl className="space-y-1 text-xs">
                {lines.map((line) => (
                  <div key={line.label} className="flex justify-between gap-3">
                    <dt className="text-polaris-muted">{line.label}</dt>
                    <dd className="selectable font-mono text-polaris-text">{line.value}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-polaris-muted">
                Guard {state.guardContractId.slice(0, 4)}…{state.guardContractId.slice(-4)}
              </p>
            </section>

            <ProfileForm
              state={state}
              mode={mode}
              onModeChange={setMode}
              fields={fields}
              onFieldsChange={setFields}
              executor={executor}
              onExecutorChange={setExecutor}
              revokeAllowance={revokeAllowance}
              onRevokeAllowanceChange={setRevokeAllowance}
              running={running}
              onAction={onAction}
            />

            <AliasEditor aliases={aliases} running={running} onSave={onSaveAliases} />

            {planError ? (
              <p className="text-xs text-polaris-danger" role="alert">
                {planError}
              </p>
            ) : null}

            {plan && plan.steps.length > 0 ? (
              <section className="space-y-2 rounded-lg border border-polaris-line bg-polaris-panel/60 p-3">
                <h2 className="text-sm font-semibold">Signing plan</h2>
                <p className="text-xs text-polaris-muted">{plan.note}</p>
                <ol className="space-y-1 text-xs">
                  {plan.steps.map((step, index) => (
                    <li key={`${step.label}-${index}`} className="flex justify-between gap-3">
                      <span>
                        {index + 1}. {step.label}
                      </span>
                      <StepStatus outcomes={tx.outcomes} index={index} />
                    </li>
                  ))}
                </ol>
                {tx.progress ? (
                  <p className="text-xs text-polaris-muted">
                    Step {tx.progress.index + 1}/{tx.progress.total}: {tx.progress.label} ({tx.progress.phase})
                  </p>
                ) : null}
              </section>
            ) : null}

            {plan && plan.steps.length === 0 ? <PanelNote>{plan.note}</PanelNote> : null}
          </>
        ) : null}
      </div>
    </PanelShell>
  );
}

/** The per-step outcome badge: text plus colour, never colour alone. */
function StepStatus({ outcomes, index }: { outcomes: readonly TxRunOutcome[]; index: number }) {
  const outcome = outcomes[index];
  if (!outcome) return <span className="text-polaris-muted">waiting</span>;
  if (outcome.status === "submitted") {
    return (
      <a
        href={outcome.explorerUrl}
        target="_blank"
        rel="noreferrer"
        className="text-polaris-ok hover:underline"
      >
        submitted
      </a>
    );
  }
  if (outcome.status === "denied") return <span className="text-polaris-warn">denied</span>;
  return <span className="text-polaris-danger">failed</span>;
}
