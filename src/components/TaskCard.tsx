import { useRef, useState, type ReactElement } from "react";
import { animate, motion, useMotionValue, useMotionValueEvent, useTransform } from "motion/react";
import type { Status, Task } from "../store";
import { dueLabel } from "../date";
import { haptic } from "../haptics";
import { Check, Play, Sparkle, Trash, Undo } from "./Icons";

const THRESH = 84;
/** これ以上の速さ (px/s) で払えば、距離が短くてもフリックとみなす */
const FLICK_V = 350;

type Action = { kind: "status"; to: Status } | { kind: "delete" };
type Meta = { label: string; color: string; icon: ReactElement };

/** 右フリック = 次へ、左フリック = 前へ。端（未着手の左 / 完了の右）は削除 */
export const NEXT: Record<Status, Action> = {
  todo: { kind: "status", to: "doing" },
  doing: { kind: "status", to: "done" },
  done: { kind: "delete" },
};
export const PREV: Record<Status, Action> = {
  todo: { kind: "delete" },
  doing: { kind: "status", to: "todo" },
  done: { kind: "status", to: "doing" },
};

function meta(a: Action): Meta {
  if (a.kind === "delete") return { label: "削除", color: "var(--red)", icon: <Trash size={22} /> };
  if (a.to === "doing") return { label: "進行中へ", color: "var(--orange)", icon: <Play size={20} /> };
  if (a.to === "done") return { label: "完了", color: "var(--green)", icon: <Check size={22} /> };
  return { label: "未着手へ", color: "var(--gray)", icon: <Undo size={21} /> };
}

type Props = {
  task: Task;
  index: number;
  onOpen: (t: Task) => void;
  onAction: (t: Task, a: Action) => void;
  onToggleDone: (t: Task) => void;
};

export function TaskCard({ task, index, onOpen, onAction, onToggleDone }: Props) {
  const x = useMotionValue(0);
  const armed = useRef<0 | 1 | -1>(0);
  const dragging = useRef(false);
  const [armedState, setArmedState] = useState<0 | 1 | -1>(0);
  const next = meta(NEXT[task.status]);
  const prev = meta(PREV[task.status]);

  useMotionValueEvent(x, "change", (v) => {
    const a = v > THRESH ? 1 : v < -THRESH ? -1 : 0;
    if (a !== armed.current) {
      armed.current = a;
      setArmedState(a);
      if (a) haptic("light");
    }
  });

  const leftBg = useTransform(x, [0, 16, THRESH], [0, 0.55, 1]);
  const rightBg = useTransform(x, [-THRESH, -16, 0], [1, 0.55, 0]);
  const leftIconX = useTransform(x, [0, THRESH, 260], [-18, 0, 40]);
  const rightIconX = useTransform(x, [-260, -THRESH, 0], [-40, 0, 18]);
  const tilt = useTransform(x, [-260, 0, 260], [-1.2, 0, 1.2]);

  const due = task.due_date ? dueLabel(task.due_date) : null;
  const done = task.status === "done";
  const freshAi = task.aiAt && Date.now() - task.aiAt < 6000;

  return (
    <motion.li
      layout="position"
      className="row"
      data-testid="task"
      data-status={task.status}
      data-title={task.title}
      initial={{ opacity: 0, y: 28, scale: 0.94, filter: "blur(6px)" }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)", transition: { type: "spring", stiffness: 420, damping: 32, delay: Math.min(index, 10) * 0.035 } }}
      exit={{ opacity: 0, height: 0, marginBottom: 0, transition: { duration: 0.28, ease: [0.2, 0.9, 0.25, 1] } }}
    >
      <motion.div className={`swipe-bg left ${armedState === 1 ? "armed" : ""}`} style={{ opacity: leftBg, background: next.color }} aria-hidden="true">
        <motion.span className="swipe-icon" style={{ x: leftIconX }}>{next.icon}<em>{next.label}</em></motion.span>
      </motion.div>
      <motion.div className={`swipe-bg right ${armedState === -1 ? "armed" : ""}`} style={{ opacity: rightBg, background: prev.color }} aria-hidden="true">
        <motion.span className="swipe-icon" style={{ x: rightIconX }}><em>{prev.label}</em>{prev.icon}</motion.span>
      </motion.div>

      <motion.div
        className={`card ${done ? "is-done" : ""} ${task.aiPending ? "ai-pending" : ""} ${freshAi ? "ai-fresh" : ""}`}
        style={{ x, rotate: tilt }}
        drag="x"
        dragDirectionLock
        dragMomentum={false}
        dragElastic={0}
        whileTap={{ scale: 0.985 }}
        onDragStart={() => { dragging.current = true; }}
        onTap={(e) => {
          if (dragging.current || Math.abs(x.get()) > 4) return;
          if ((e.target as HTMLElement).closest(".check")) return;
          onOpen(task);
        }}
        onDragEnd={(_, info) => {
          setTimeout(() => { dragging.current = false; }, 50);
          const off = info.offset.x;
          const v = info.velocity.x;
          const dir = off > THRESH || (v > FLICK_V && off > 24) ? 1 : off < -THRESH || (v < -FLICK_V && off < -24) ? -1 : 0;
          if (!dir) {
            animate(x, 0, { type: "spring", stiffness: 520, damping: 34 });
            return;
          }
          haptic("medium");
          animate(x, dir * (window.innerWidth + 60), { type: "spring", stiffness: 260, damping: 32, velocity: v }).then(() => {
            onAction(task, dir === 1 ? NEXT[task.status] : PREV[task.status]);
          });
        }}
      >
        <button
          className={`check s-${task.status}`}
          aria-label={done ? "未完了に戻す" : "完了にする"}
          data-testid="check"
          onClick={(e) => {
            e.stopPropagation();
            onToggleDone(task);
          }}
        >
          <svg viewBox="0 0 28 28" aria-hidden="true">
            <circle cx="14" cy="14" r="11.5" className="ring" />
            {task.status === "doing" && <motion.circle cx="14" cy="14" r="11.5" className="ring-doing" initial={{ pathLength: 0 }} animate={{ pathLength: 0.5 }} transition={{ type: "spring", stiffness: 120, damping: 18 }} />}
            <motion.circle cx="14" cy="14" r="11.5" className="fill" initial={false} animate={{ scale: done ? 1 : 0, opacity: done ? 1 : 0 }} transition={{ type: "spring", stiffness: 500, damping: 26 }} />
            <motion.path d="M8.5 14.5l3.6 3.6 7.4-8" className="tick" initial={false} animate={{ pathLength: done ? 1 : 0 }} transition={{ duration: 0.32, delay: done ? 0.08 : 0, ease: "easeOut" }} />
          </svg>
        </button>
        <div className="card-body">
          <div className="card-title" data-testid="task-title">{task.title}</div>
          {(due || task.note || task.aiAt) && (
            <div className="card-meta">
              {due && <span className={`due due-${due.tone}`} data-testid="due">{due.text}</span>}
              {task.aiAt && <Sparkle size={13} className="ai-mark" />}
              {task.note && <span className="note">{task.note}</span>}
            </div>
          )}
        </div>
      </motion.div>
    </motion.li>
  );
}
