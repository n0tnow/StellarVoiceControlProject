/**
 * Rules page — the owner's on-chain guard rules, now editable.
 *
 * The rows use the Security panel's read-back wording; the form below them edits
 * the limits and submits through `executeApprovedIntent`, so a change opens the
 * batch approval card and takes ONE Touch ID. Disabling (Always ask) and syncing
 * the saved contacts are the same flow. Locked and empty/error states are shown
 * inline; see `notch/rules/RulesEditor.tsx` and `rulesModel.ts`.
 */
import { RulesEditor } from "@/notch/rules/RulesEditor";

import "./tasks-rules.css";
import { LoginGate } from "../wallet/LoginGate";
import { useWalletLocked } from "../wallet/useWalletSession";

export function RulesPage() {
  const locked = useWalletLocked();
  if (locked) return <LoginGate />;
  return (
    <div className="page-stack nr-page">
      <RulesEditor />
    </div>
  );
}
