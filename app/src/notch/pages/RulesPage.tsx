/**
 * Rules / Policies page — the user's spending rulesets.
 *
 * Cards follow the guard's vocabulary: condition → action → approval profile
 * (`none` / `touch_id` / `always_ask`, from the approval layer). Toggles and
 * the "add rule" row are local mock state; a real `set_rule` flow (with the
 * approval card from `backlog/approval-policy.md`) replaces them later.
 */
import { useState } from "react";
import { Fingerprint, Plus, ShieldCheck } from "lucide-react";

import {
  MOCK_RULES,
  type ApprovalRequirement,
  type GuardRule,
} from "@/lib/mockData";

const APPROVAL_LABEL: Record<ApprovalRequirement, string> = {
  none: "no approval",
  touch_id: "Touch ID",
  always_ask: "always ask",
};

export function RulesPage() {
  const [rules, setRules] = useState<GuardRule[]>(MOCK_RULES);

  const toggle = (id: string): void => {
    setRules((current) =>
      current.map((rule) =>
        rule.id === id ? { ...rule, enabled: !rule.enabled } : rule,
      ),
    );
  };

  return (
    <div className="page-stack">
      <ul className="page-list rule-list">
        {rules.map((rule) => (
          <li key={rule.id} className={`rule-card${rule.enabled ? "" : " is-disabled"}`}>
            <div className="rule-head">
              <ShieldCheck className="rule-icon" aria-hidden="true" />
              <span className="rule-name">{rule.name}</span>
              <button
                type="button"
                role="switch"
                aria-checked={rule.enabled}
                aria-label={`${rule.enabled ? "Disable" : "Enable"} rule: ${rule.name}`}
                className={`page-toggle${rule.enabled ? " is-on" : ""}`}
                onClick={() => toggle(rule.id)}
              >
                <span className="page-toggle-knob" />
              </button>
            </div>
            <p className="rule-body">
              <span className="rule-condition">{rule.condition}</span>
              <span className="rule-arrow" aria-hidden="true">
                →
              </span>
              <span className="rule-action">{rule.action}</span>
            </p>
            <p className="rule-approval">
              <Fingerprint aria-hidden="true" />
              Approval: {APPROVAL_LABEL[rule.approval]}
            </p>
          </li>
        ))}
      </ul>
      {/* Mock affordance: the real flow is a voice-drafted rule reviewed on an
          approval card before `set_rule` touches the chain. */}
      <button
        type="button"
        className="rule-add"
        onClick={() => {
          /* Mock-only affordance: rule creation is a guarded flow, not a form. */
        }}
      >
        <Plus aria-hidden="true" />
        Add rule — coming with guard wiring
      </button>
    </div>
  );
}
