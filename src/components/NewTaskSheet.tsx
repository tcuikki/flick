import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useDragControls } from "motion/react";
import { STATUS_LABEL, type Status, addTask } from "../store";
import { addDaysISO, dueLabel } from "../date";
import { haptic } from "../haptics";

type Props = {
  open: boolean;
  defaultStatus: Status;
  onClose: () => void;
  onAdded: (status: Status) => void;
};

const STATUS_CHOICES: Status[] = ["todo", "doing"];

/** ＋ボタンから開く追加シート：状態 → 期限 → やること・メモ の順に選んで追加する */
export function NewTaskSheet({ open, defaultStatus, onClose, onAdded }: Props) {
  const drag = useDragControls();
  const [status, setStatus] = useState<Status>("todo");
  const [due, setDue] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setStatus(defaultStatus === "doing" ? "doing" : "todo");
    setDue(null);
    setTitle("");
    setNote("");
    // primeKeyboard() で開いたキーボードを、やることの欄へ引き継ぐ
    const t = requestAnimationFrame(() => titleRef.current?.focus({ preventScroll: true }));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.documentElement.classList.add("sheet-open");
    return () => {
      cancelAnimationFrame(t);
      window.removeEventListener("keydown", onKey);
      document.documentElement.classList.remove("sheet-open");
    };
  }, [open, defaultStatus, onClose]);

  const quick: { label: string; value: string | null }[] = [
    { label: "今日", value: addDaysISO(0) },
    { label: "明日", value: addDaysISO(1) },
    { label: "来週", value: addDaysISO(7) },
    { label: "なし", value: null },
  ];
  const custom = due && !quick.some((q) => q.value === due);
  const canAdd = title.trim().length > 0;

  const submit = () => {
    const text = title.trim();
    if (!text) return;
    // 期限を選んだときは AI に任せない（選んだ期限と打った文をそのまま使う）。
    // 期限「なし」のときは、文の中の「明日までに」などを AI が読み取る
    addTask(text, due ? { title: text, status, due_date: due, note } : { status, note });
    haptic("success");
    onAdded(status);
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div key="scrim" className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.section
            key="sheet"
            className="sheet sheet-top glass"
            role="dialog"
            aria-modal="true"
            aria-label="タスクを追加"
            data-testid="new-sheet"
            drag="y"
            dragControls={drag}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0.7, bottom: 0.04 }}
            onDragEnd={(_, i) => (i.offset.y < -90 || i.velocity.y < -650) && onClose()}
            initial={{ y: "-105%", scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: "-110%", scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 36, mass: 0.9 }}
          >

            <div className="seg seg-2" role="radiogroup" aria-label="状態">
              {STATUS_CHOICES.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={status === s}
                  className={`seg-btn ${status === s ? "on" : ""}`}
                  onClick={() => { haptic(); setStatus(s); }}
                >
                  {status === s && <motion.span layoutId="new-seg-pill" className={`seg-pill s-${s}`} transition={{ type: "spring", stiffness: 520, damping: 34 }} />}
                  <span>{STATUS_LABEL[s]}</span>
                </button>
              ))}
            </div>

            <div className="field">
              <div className="chips" role="radiogroup" aria-label="期限">
                {quick.map((q) => (
                  <motion.button
                    key={q.label}
                    type="button"
                    role="radio"
                    aria-checked={due === q.value}
                    whileTap={{ scale: 0.92 }}
                    className={`chip ${due === q.value ? "on" : ""}`}
                    onClick={() => { haptic(); setDue(q.value); }}
                  >
                    {q.label}
                  </motion.button>
                ))}
                <label className={`chip date-chip ${custom ? "on" : ""}`}>
                  {custom ? dueLabel(due!).text : "日付"}
                  <input type="date" aria-label="期限日" data-testid="new-due-input" value={due ?? ""} onChange={(e) => setDue(e.target.value || null)} />
                </label>
              </div>
            </div>

            <form
              className="new-form"
              onSubmit={(e) => { e.preventDefault(); submit(); }}
            >
              <div className="new-row">
                <input
                  ref={titleRef}
                  className="new-title"
                  type="text"
                  value={title}
                  placeholder="やること"
                  aria-label="やること"
                  enterKeyHint="done"
                  maxLength={500}
                  autoComplete="off"
                  data-testid="new-title"
                  onChange={(e) => setTitle(e.target.value)}
                />
                <motion.button
                  type="submit"
                  className="new-add"
                  disabled={!canAdd}
                  whileTap={canAdd ? { scale: 0.92 } : undefined}
                  data-testid="new-add"
                >
                  追加
                </motion.button>
              </div>
              <textarea
                className="sheet-note new-note"
                placeholder="メモ（なくてもOK）"
                value={note}
                rows={1}
                aria-label="メモ"
                data-testid="new-note"
                onChange={(e) => {
                  setNote(e.target.value);
                  const el = e.target;
                  el.style.height = "auto";
                  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
                }}
              />
            </form>
            <div className="grabber-zone bottom" onPointerDown={(e) => drag.start(e)}>
              <div className="grabber" />
            </div>
          </motion.section>
        </>
      )}
    </AnimatePresence>
  );
}
