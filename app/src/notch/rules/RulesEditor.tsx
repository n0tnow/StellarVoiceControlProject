/**
 * The notch Rules editor (W11b): a functional view of the on-chain guard state.
 *
 * Every card is unchanged from the read-only page; the form below it edits the
 * limits and submits through `executeApprovedIntent`, so the Rules page and the
 * voice path share ONE batch approval card + ONE Touch ID. `disable` forces the
 * Always-ask plan; `sync contacts` re-runs the current plan, which mirrors the
 * saved contacts into the on-chain alias book.
 */
import { CircleAlert, Power, RefreshCw, Save, ShieldCheck, Users } from "lucide-react";

import { openPanel } from "@/lib/panels";

import { rulesView } from "./rulesModel";
import { useRulesEditor } from "./useRulesEditor";

/** A small labelled decimal input that keeps the notch's look. */
function LimitField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="task-new">
      <span className="rule-condition">{label}</span>
      <input
        className="task-new-input"
        inputMode="decimal"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function RulesEditor() {
  const editor = useRulesEditor();
  const { state, detail, security, form, patch, contacts, executorFunded, autoPaySupported, busy, message } =
    editor;

  if (state === "loading") return <p className="rule-condition">Reading spending rules…</p>;

  if (state === "unconfigured" || state === "error") {
    return (
      <div className="rule-card">
        <div className="rule-head">
          <CircleAlert className="rule-icon" aria-hidden="true" />
          <span className="rule-name">
            {state === "error" ? "Could not read the rules" : "Guard not configured"}
          </span>
        </div>
        <p className="rule-body">
          <span className="rule-condition">{detail}</span>
        </p>
        {state === "error" ? (
          <button type="button" className="rule-add" onClick={editor.refresh}>
            <RefreshCw aria-hidden="true" />
            Retry
          </button>
        ) : null}
      </div>
    );
  }

  const lines = security ? rulesView(security, contacts, executorFunded) : [];
  const disabled = busy || security === null;

  return (
    <>
      {!autoPaySupported ? (
        <p className="rule-condition">
          Automatic payments aren&apos;t enabled in this build yet — the agent-key commands are missing.
        </p>
      ) : null}

      {state === "not_set_up" ? (
        <p className="rule-condition">No spending rule yet. Set your limits below to publish one.</p>
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

      <div className="rule-card">
        <div className="rule-head">
          <ShieldCheck className="rule-icon" aria-hidden="true" />
          <span className="rule-name">Limits</span>
        </div>
        <LimitField
          label={`Auto limit (${security?.assetSymbol ?? "XLM"})`}
          value={form.threshold}
          disabled={disabled}
          onChange={(threshold) => patch({ threshold, mode: "auto_under_limit" })}
        />
        <LimitField
          label="Per payment"
          value={form.perTx}
          disabled={disabled}
          onChange={(perTx) => patch({ perTx })}
        />
        <LimitField
          label="Per day"
          value={form.daily}
          disabled={disabled}
          onChange={(daily) => patch({ daily })}
        />
        <button
          type="button"
          className="page-toggle"
          aria-pressed={form.knownRecipientsOnly}
          disabled={disabled}
          onClick={() => patch({ knownRecipientsOnly: !form.knownRecipientsOnly })}
        >
          <span className="page-toggle-knob" />
        </button>
        <span className="rule-condition">Known recipients only</span>

        <div className="rule-approval">
          <Users aria-hidden="true" />
          <span>
            {contacts.length} saved contact{contacts.length === 1 ? "" : "s"} · saved on-chain when you save
          </span>
        </div>

        <button type="button" className="rule-add" disabled={disabled} onClick={() => void editor.save()}>
          <Save aria-hidden="true" />
          {busy ? "Waiting…" : "Save rule (one approval)"}
        </button>
        <button
          type="button"
          className="rule-add"
          disabled={disabled}
          onClick={() => void editor.syncContacts()}
        >
          <RefreshCw aria-hidden="true" />
          Sync contacts
        </button>
        <button
          type="button"
          className="rule-add"
          disabled={disabled}
          onClick={() => void editor.disable()}
        >
          <Power aria-hidden="true" />
          Always ask (turn auto-pay off)
        </button>
      </div>

      {message ? (
        <p className="rule-condition" role="status">
          {message}
        </p>
      ) : null}

      <button
        type="button"
        className="rule-add"
        onClick={() => void openPanel("security").catch(() => {})}
      >
        Open the Security panel
      </button>
    </>
  );
}
