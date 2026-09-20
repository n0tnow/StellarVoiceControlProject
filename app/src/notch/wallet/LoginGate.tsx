/**
 * The compact "Log in to use this" state (task W13b).
 *
 * Shown in place of the History / Tasks / Rules bodies (and the "⋯" menu
 * entries) while the wallet session is `locked` or `none`, so a gated page never
 * reads the chain. Presentation only; the Wallet page is where the user logs in.
 */
import { Lock } from "lucide-react";

export function LoginGate() {
  return (
    <div className="page-stack">
      <div className="rule-card">
        <div className="rule-head">
          <Lock className="rule-icon" aria-hidden="true" />
          <span className="rule-name">Log in to use this</span>
        </div>
        <p className="rule-body">
          <span className="rule-condition">
            Your wallet is locked. Open the Wallet page and unlock it first.
          </span>
        </p>
      </div>
    </div>
  );
}
