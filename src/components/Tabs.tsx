import { AnimatePresence, motion } from "motion/react";
import { STATUSES, STATUS_LABEL, type Status } from "../store";
import { haptic } from "../haptics";

type Props = { value: Status; counts: Record<Status, number>; onChange: (s: Status) => void };

/** 下部に浮くガラスのタブ。選択中のレンズが液体のように伸びて移動する */
export function Tabs({ value, counts, onChange }: Props) {
  return (
    <motion.nav
      className="tabs glass"
      role="tablist"
      aria-label="ステータス"
      initial={{ y: 40, opacity: 0, scale: 0.96 }}
      animate={{ y: 0, opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 360, damping: 30, delay: 0.05 }}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        e.currentTarget.style.setProperty("--mx", `${((e.clientX - r.left) / r.width) * 100}%`);
      }}
    >
      {STATUSES.map((s) => {
        const on = s === value;
        return (
          <motion.button
            key={s}
            role="tab"
            aria-selected={on}
            data-testid={`tab-${s}`}
            className={`tab ${on ? "on" : ""}`}
            whileTap={{ scale: 0.9 }}
            onClick={() => { if (!on) { haptic(); onChange(s); } }}
          >
            {on && (
              <motion.span
                layoutId="tab-lens"
                className="tab-lens"
                transition={{ type: "spring", stiffness: 460, damping: 30, mass: 0.8 }}
              />
            )}
            <span className={`tab-dot s-${s}`} />
            <span className="tab-label">{STATUS_LABEL[s]}</span>
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
          </motion.button>
        );
      })}
    </motion.nav>
  );
}
