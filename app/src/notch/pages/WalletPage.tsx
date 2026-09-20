/**
 * Wallet page — the professional wallet experience (task W13b).
 *
 * The Rust session decides the screen: `none` → Create / Import, `locked` →
 * the Touch ID unlock screen, `unlocked` → the wallet dashboard. When the
 * session engine is absent from this build (feature-detected) the page keeps the
 * W10b body unchanged, so an older shell still works.
 *
 * The `notch/wallet/**` components own the surfaces; the data hooks own the
 * reads. Nothing on this page logs, stores or moves a secret on its own.
 */
import { useWalletSession } from "@/notch/wallet/useWalletSession";
import { LegacyWalletView } from "@/notch/wallet/LegacyWalletView";
import { SessionWalletView } from "@/notch/wallet/SessionWalletView";

export function WalletPage() {
  const { available } = useWalletSession();
  if (available === false) return <LegacyWalletView />;
  return <SessionWalletView />;
}
