import { AnimatePresence, motion } from "motion/react";
import { haptic } from "../haptics";
import { Checklist, MailIcon, Sun } from "./Icons";

export type Page = "today" | "mail" | "tasks";
export const PAGES: Page[] = ["today", "mail", "tasks"];
export const PAGE_LABEL: Record<Page, string> = { today: "今日", mail: "メール", tasks: "タスク" };
const ICON: Record<Page, (p: { size?: number }) => React.JSX.Element> = { today: Sun, mail: MailIcon, tasks: Checklist };

type Props = { value: Page; onChange: (p: Page) => void; mailBadge: number; mailWarn: boolean; taskCount: number };

/** 下部に浮くガラスのタブ（今日・メール・タスク）。選択中のレンズが液体のように伸びて移動する */
export function BottomNav({ value, onChange, mailBadge, mailWarn, taskCount }: Props) {
  return (
    <motion.nav
      className="tabs glass"
      role="tablist"
      aria-label="画面"
      initial={{ y: 40, opacity: 0, scale: 0.96 }}
      animate={{ y: 0, opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 360, damping: 30, delay: 0.05 }}
    >
      {PAGES.map((p) => {
        const on = p === value;
        const Icon = ICON[p];
        return (
          <motion.button
            key={p}
            role="tab"
            aria-selected={on}
            data-testid={`nav-${p}`}
            className={`tab nav-${p} ${on ? "on" : ""}`}
            whileTap={{ scale: 0.9 }}
            onClick={() => { if (!on) { haptic(); onChange(p); } }}
          >
            {on && <motion.span layoutId="tab-lens" className="tab-lens" transition={{ type: "spring", stiffness: 460, damping: 30, mass: 0.8 }} />}
            <span className="tab-icon">
              <Icon size={20} />
              <AnimatePresence>
                {p === "mail" && (mailBadge > 0 || mailWarn) && (
                  <motion.i
                    key="b"
                    className={`nav-badge ${mailBadge ? "" : "warn"}`}
                    data-testid="mail-badge"
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    exit={{ scale: 0 }}
                    transition={{ type: "spring", stiffness: 600, damping: 20 }}
                  >
                    {mailBadge > 0 ? (mailBadge > 99 ? "99+" : mailBadge) : "!"}
                  </motion.i>
                )}
              </AnimatePresence>
            </span>
            <span className="tab-label">{PAGE_LABEL[p]}</span>
            {p === "tasks" && taskCount > 0 && <span className="sr-only">（未完了 {taskCount}件）</span>}
          </motion.button>
        );
      })}
    </motion.nav>
  );
}
