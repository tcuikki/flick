import { AnimatePresence, motion } from "motion/react";
import { STATUSES, STATUS_LABEL, type Status } from "../store";
import { haptic } from "../haptics";

type Props = { value: Status; counts: Record<Status, number>; onChange: (s: Status) => void };

/** タスクの画面の上：未着手・進行中・完了の切り替え（押すと一覧が横にスライドする） */
export function StatusTabs({ value, counts, onChange }: Props) {
  return (
    <div className="status-tabs seg" role="tablist" aria-label="ステータス" data-testid="status-tabs">
      {STATUSES.map((s) => {
        const on = s === value;
        return (
          <button
            key={s}
            role="tab"
            aria-selected={on}
            data-testid={`tab-${s}`}
            className={`seg-btn ${on ? "on" : ""}`}
            onClick={() => { if (!on) { haptic(); onChange(s); } }}
          >
            {on && <motion.span layoutId="status-pill" className={`seg-pill s-${s}`} transition={{ type: "spring", stiffness: 520, damping: 34 }} />}
            <span className="status-tab-inner">
              <span>{STATUS_LABEL[s]}</span>
              <span className="tab-count" data-testid={`count-${s}`}>
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={counts[s]}
                    initial={{ y: 10, opacity: 0, filter: "blur(3px)" }}
                    animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
                    exit={{ y: -10, opacity: 0, filter: "blur(3px)" }}
                    transition={{ type: "spring", stiffness: 500, damping: 30 }}
                  >
                    {counts[s]}
                  </motion.span>
                </AnimatePresence>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
