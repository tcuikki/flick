import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useDragControls } from "motion/react";
import { STATUSES, STATUS_LABEL, type Task, updateTask, useStore } from "../store";
import { addDaysISO, dueLabel } from "../date";
import { Sparkle, Trash } from "./Icons";
import { haptic } from "../haptics";

type Props = {
  taskId: string | null;
  onClose: () => void;
  onDelete: (t: Task) => void;
  onBreakdown: (t: Task) => Promise<void>;
};

export function TaskSheet({ taskId, onClose, onDelete, onBreakdown }: Props) {
  const task = useStore((s) => s.tasks.find((t) => t.id === taskId) ?? null);
  const aiOn = useStore((s) => s.auth === "in");
  const drag = useDragControls();
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!taskId) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.documentElement.classList.add("sheet-open");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.documentElement.classList.remove("sheet-open");
    };
  }, [taskId, onClose]);

  useEffect(() => {
    const el = titleRef.current;
    if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }
  }, [task?.title, taskId]);

  const quick: { label: string; value: string | null }[] = [
    { label: "今日", value: addDaysISO(0) },
    { label: "明日", value: addDaysISO(1) },
    { label: "来週", value: addDaysISO(7) },
    { label: "なし", value: null },
  ];

  return (
    <AnimatePresence>
      {task && (
        <>
          <motion.div
            key="scrim"
            className="scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.section
            key="sheet"
            className="sheet glass"
            role="dialog"
            aria-modal="true"
            aria-label="タスクの詳細"
            data-testid="sheet"
            drag="y"
            dragControls={drag}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0.04, bottom: 0.7 }}
            onDragEnd={(_, i) => (i.offset.y > 110 || i.velocity.y > 650) && onClose()}
            initial={{ y: "100%", scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: "105%", scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 36, mass: 0.9 }}
          >
            <div className="grabber-zone" onPointerDown={(e) => drag.start(e)}>
              <div className="grabber" />
            </div>

            <textarea
              ref={titleRef}
              className="sheet-title"
              rows={1}
              value={task.title}
              aria-label="タイトル"
              data-testid="sheet-title"
              onChange={(e) => updateTask(task.id, { title: e.target.value.replace(/\n/g, " ") })}
              onBlur={(e) => !e.target.value.trim() && updateTask(task.id, { title: "無題" })}
            />

            <div className="seg" role="radiogroup" aria-label="ステータス">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  role="radio"
                  aria-checked={task.status === s}
                  className={`seg-btn ${task.status === s ? "on" : ""}`}
                  onClick={() => { haptic(); updateTask(task.id, { status: s }); }}
                >
                  {task.status === s && <motion.span layoutId="seg-pill" className={`seg-pill s-${s}`} transition={{ type: "spring", stiffness: 520, damping: 34 }} />}
                  <span>{STATUS_LABEL[s]}</span>
                </button>
              ))}
            </div>

            <div className="field">
              <div className="chips">
                {quick.map((q) => (
                  <motion.button
                    key={q.label}
                    whileTap={{ scale: 0.92 }}
                    className={`chip ${task.due_date === q.value ? "on" : ""}`}
                    onClick={() => { haptic(); updateTask(task.id, { due_date: q.value }); }}
                  >
                    {q.label}
                  </motion.button>
                ))}
                <label className={`chip date-chip ${task.due_date && !quick.some((q) => q.value === task.due_date) ? "on" : ""}`}>
                  {task.due_date && !quick.some((q) => q.value === task.due_date) ? dueLabel(task.due_date).text : "日付"}
                  <input
                    type="date"
                    aria-label="期限日"
                    data-testid="due-input"
                    value={task.due_date ?? ""}
                    onChange={(e) => updateTask(task.id, { due_date: e.target.value || null })}
                  />
                </label>
              </div>
            </div>

            <textarea
              className="sheet-note"
              placeholder="メモ"
              value={task.note}
              rows={3}
              aria-label="メモ"
              data-testid="sheet-note"
              onChange={(e) => updateTask(task.id, { note: e.target.value })}
            />

            <div className="sheet-actions">
              {aiOn && (
                <motion.button
                  className={`ai-btn ${busy ? "busy" : ""}`}
                  whileTap={{ scale: 0.95 }}
                  disabled={busy}
                  data-testid="breakdown"
                  onClick={async () => {
                    setBusy(true);
                    try { await onBreakdown(task); } finally { setBusy(false); }
                  }}
                >
                  <Sparkle size={17} />
                  <span>{busy ? "分解中…" : "AIで分解"}</span>
                </motion.button>
              )}
              <motion.button className="del-btn" whileTap={{ scale: 0.95 }} aria-label="削除" data-testid="delete" onClick={() => onDelete(task)}>
                <Trash size={19} />
              </motion.button>
            </div>
          </motion.section>
        </>
      )}
    </AnimatePresence>
  );
}
