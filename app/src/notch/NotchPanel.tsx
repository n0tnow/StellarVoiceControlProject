/**
 * The notch panel body — the multi-page surface the `panel` shell state shows.
 *
 * Layout: a compact icon+label nav on the left (History / Tasks / Rules /
 * Wallet) and the active page in a scrolling column on the right. The shell
 * owns the window, the geometry and the expand animation; this component owns
 * only which page is rendered inside it.
 *
 * Routing is the `useNotchPage` seam: the nav is today's only caller of
 * `setNotchPage`, but the voice-wiring follow-up calls the same setter with a
 * page name derived from the intent ("geçmişi aç" → `setNotchPage("history")`)
 * without touching this component.
 */
import { useEffect } from "react";
import { Clock, History, ShieldCheck, Wallet, X } from "lucide-react";

import { NOTCH_PAGES, type NotchPage } from "./notchPage";
import type { NotchPageController } from "./useNotchPage";
import { HistoryPage } from "./pages/HistoryPage";
import { TasksPage } from "./pages/TasksPage";
import { RulesPage } from "./pages/RulesPage";
import { WalletPage } from "./pages/WalletPage";

const PAGE_META: Record<NotchPage, { label: string; Icon: typeof History }> = {
  history: { label: "History", Icon: History },
  tasks: { label: "Tasks", Icon: Clock },
  rules: { label: "Rules", Icon: ShieldCheck },
  wallet: { label: "Wallet", Icon: Wallet },
};

const PAGE_BODY: Record<NotchPage, () => React.JSX.Element> = {
  history: HistoryPage,
  tasks: TasksPage,
  rules: RulesPage,
  wallet: WalletPage,
};

export interface NotchPanelProps {
  /** The page-routing controller, owned by `ShellSurface`. */
  controller: NotchPageController;
}

export function NotchPanel({ controller }: NotchPanelProps) {
  const { page, setNotchPage, close } = controller;
  const ActivePage = PAGE_BODY[page];

  // Escape is the keyboard way out of the panel; the pointer path (hover
  // leave with its grace period) is owned by the shell reducer.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  return (
    <div className="notch-panel-inner">
      <nav className="panel-nav" aria-label="Notch pages">
        {NOTCH_PAGES.map((name) => {
          const { label, Icon } = PAGE_META[name];
          const active = name === page;
          return (
            <button
              key={name}
              type="button"
              className={`panel-nav-item${active ? " is-active" : ""}`}
              aria-current={active ? "page" : undefined}
              onClick={() => setNotchPage(name)}
            >
              <Icon aria-hidden="true" />
              <span>{label}</span>
            </button>
          );
        })}
        <button
          type="button"
          className="panel-nav-item panel-nav-close"
          aria-label="Close panel"
          onClick={close}
        >
          <X aria-hidden="true" />
          <span>Close</span>
        </button>
      </nav>
      <section className="panel-body polaris-scroll" aria-label={PAGE_META[page].label}>
        <ActivePage />
      </section>
    </div>
  );
}
