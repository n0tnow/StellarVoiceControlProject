/**
 * Rules page — a read-only summary of the owner's on-chain guard rules.
 *
 * The rows use the Security panel's exact read-back wording (`stateLines`):
 * profile, executor, limits, recipients, allowance, spent-today and the alias
 * book size. Nothing is editable here — "Edit rules" opens the Security panel,
 * where every change goes through the shared tx pipeline (approval card →
 * Touch ID → Freighter). Reads come from `useRulesData`; a browser preview
 * shows the labelled mock demo, and a failed read shows an error with Retry.
 */
import { CircleAlert, PenLine, RefreshCw, ShieldCheck } from "lucide-react";

import { openPanel } from "@/lib/panels";
import { useRulesData } from "@/notch/data/useRulesData";

import { LoginGate } from "../wallet/LoginGate";
import { useWalletLocked } from "../wallet/useWalletSession";

export function RulesPage() {
  const locked = useWalletLocked();
  if (locked) return <LoginGate />;
  return <RulesBody />;
}

function RulesBody() {
  const { state, lines, detail, demo, refresh } = useRulesData();

  const editRules = (): void => {
    // Ignore the rejection outside Tauri (the demo preview has no panel windows).
    void openPanel("security").catch(() => {});
  };

  return (
    <div className="page-stack">
      {state === "loading" ? (
        <p className="rule-condition">Reading spending rules…</p>
      ) : null}

      {state === "unconfigured" ? (
        <StateCard title="Guard not configured" detail={detail} />
      ) : null}

      {state === "not_set_up" ? (
        <StateCard
          title="No spending rule yet"
          detail="Publish the Always-ask baseline in the Security panel to start."
        />
      ) : null}

      {state === "error" ? (
        <div className="rule-card">
          <div className="rule-head">
            <CircleAlert className="rule-icon" aria-hidden="true" />
            <span className="rule-name">Could not read the rules</span>
          </div>
          <p className="rule-body">
            <span className="rule-condition">{detail}</span>
          </p>
          <button type="button" className="rule-add" onClick={refresh}>
            <RefreshCw aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : null}

      {state === "ready" ? (
        <>
          {demo ? (
            <p className="rule-condition">Demo data — connect a wallet to read the real rules.</p>
          ) : null}
          <ul className="page-list rule-list">
            {lines.map((line) => (
              <li key={line.label} className="rule-card">
                <div className="rule-head">
                  <span className="rule-name">{line.label}</span>
                  <span className="rule-action">{line.value}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <button type="button" className="rule-add" onClick={editRules}>
        <PenLine aria-hidden="true" />
        Edit rules in Security
      </button>
    </div>
  );
}

/** A non-ready state: a title plus the one-line reason. */
function StateCard({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rule-card">
      <div className="rule-head">
        <ShieldCheck className="rule-icon" aria-hidden="true" />
        <span className="rule-name">{title}</span>
      </div>
      {detail ? (
        <p className="rule-body">
          <span className="rule-condition">{detail}</span>
        </p>
      ) : null}
    </div>
  );
}
