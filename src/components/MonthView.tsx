import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { type CalEvent, evColor, hmOf, isoOf, loadRange, shiftDate, today, useCal } from "../calendar";
import { haptic } from "../haptics";
import { ChevronLeft, ChevronRight, Plus } from "./Icons";
import type { EventDraft } from "./EventSheet";

type Props = {
  open: boolean;
  /** 開いたときに選んでおく日（「今日」のページで見ている日） */
  initialDate: string;
  onClose: () => void;
  onEdit: (d: EventDraft) => void;
  /** その日を「今日」のページの時間割で見る */
  onPickDay: (date: string) => void;
};

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
const EMPTY: CalEvent[] = [];

/** その月の表の最初の日（その月1日がある週の日曜日）。6週間 = 42日を並べる */
function gridStart(month: string) {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  return isoOf(new Date(y, m - 1, 1 - first.getDay()));
}
const monthOf = (date: string) => date.slice(0, 7);
function shiftMonth(month: string, n: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** 1か月のカレンダー。日を押すとその日の予定が下に出て、そこから追加・変更できる */
export function MonthView({ open, initialDate, onClose, onEdit, onPickDay }: Props) {
  const [month, setMonth] = useState(monthOf(initialDate));
  const [selected, setSelected] = useState(initialDate);
  const [dir, setDir] = useState(0);
  const days = useCal((s) => s.days);
  const calendars = useCal((s) => s.calendars);
  const version = useCal((s) => s.version);
  const start = gridStart(month);
  const cells = useMemo(() => Array.from({ length: 42 }, (_, i) => shiftDate(start, i)), [start]);
  const t = today();

  useEffect(() => {
    if (!open) return;
    setMonth(monthOf(initialDate));
    setSelected(initialDate);
    setDir(0);
    document.documentElement.classList.add("month-open");
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !document.documentElement.classList.contains("sheet-open") && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      document.documentElement.classList.remove("month-open");
      window.removeEventListener("keydown", onKey);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // 表示している6週間を読む（予定を書き換えたら読み直す）
  useEffect(() => {
    if (open) void loadRange(start, 42);
  }, [open, start, version]);

  const go = (n: number) => {
    haptic("light");
    setDir(n);
    const m = shiftMonth(month, n);
    setMonth(m);
    // 選んでいる日が見えなくなるときは、その月の1日（今月なら今日）を選ぶ
    if (monthOf(selected) !== m) setSelected(m === monthOf(t) ? t : `${m}-01`);
  };

  // 表を横にスワイプして月を動かす
  const grid = useRef<HTMLDivElement>(null);
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    const el = grid.current;
    if (!el) return;
    let x0 = 0, y0 = 0, dx = 0, mode: "h" | "v" | null = null;
    const startT = (e: TouchEvent) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; mode = null; };
    const move = (e: TouchEvent) => {
      const mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
      if (!mode && (Math.abs(mx) > 10 || Math.abs(my) > 10)) mode = Math.abs(mx) > Math.abs(my) * 1.2 ? "h" : "v";
      if (mode === "h") { e.preventDefault(); dx = mx; }
    };
    const end = () => { if (mode === "h" && Math.abs(dx) > 60) goRef.current(dx < 0 ? 1 : -1); mode = null; };
    el.addEventListener("touchstart", startT, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    return () => {
      el.removeEventListener("touchstart", startT);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
    };
  }, [open]);

  const [y, m] = month.split("-").map(Number);
  const dayList = days[selected] ?? EMPTY;
  const sorted = [...dayList].sort((a, b) => (a.allDay === b.allDay ? a.start.localeCompare(b.start) : a.allDay ? -1 : 1));
  const [sy, sm, sd] = selected.split("-").map(Number);

  return (
    <AnimatePresence>
      {open && (
        <motion.section
          className="month-view"
          role="dialog"
          aria-modal="true"
          aria-label="1か月の予定"
          data-testid="month-view"
          initial={{ opacity: 0, scale: 0.96, y: 18 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: 14 }}
          transition={{ type: "spring", stiffness: 420, damping: 36 }}
        >
          <header className="month-head glass">
            <motion.button className="day-arrow" whileTap={{ scale: 0.86 }} onClick={() => go(-1)} aria-label="前の月" data-testid="month-prev"><ChevronLeft size={18} /></motion.button>
            <h2 data-testid="month-title">{y}年{m}月</h2>
            <motion.button className="day-arrow" whileTap={{ scale: 0.86 }} onClick={() => go(1)} aria-label="次の月" data-testid="month-next"><ChevronRight size={18} /></motion.button>
            {month !== monthOf(t) && (
              <motion.button className="day-today" whileTap={{ scale: 0.92 }} onClick={() => { haptic("light"); setDir(monthOf(t) > month ? 1 : -1); setMonth(monthOf(t)); setSelected(t); }} data-testid="month-today">今日</motion.button>
            )}
            <motion.button className="month-close" whileTap={{ scale: 0.88 }} onClick={onClose} aria-label="閉じる" data-testid="month-close">×</motion.button>
          </header>

          <div className="month-body">
            <div className="month-week">
              {WEEK.map((w, i) => <span key={w} className={i === 0 ? "sun" : i === 6 ? "sat" : ""}>{w}</span>)}
            </div>
            <div className="month-grid-wrap" ref={grid}>
              <AnimatePresence mode="popLayout" initial={false} custom={dir}>
                <motion.div
                  key={month}
                  className="month-grid"
                  data-testid="month-grid"
                  custom={dir}
                  initial={{ x: 60 * dir, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  exit={{ x: -60 * dir, opacity: 0 }}
                  transition={{ type: "spring", stiffness: 420, damping: 36 }}
                >
                  {cells.map((d, i) => {
                    const list = days[d] ?? EMPTY;
                    const inMonth = monthOf(d) === month;
                    const wd = i % 7;
                    return (
                      <button
                        key={d}
                        className={`month-cell ${inMonth ? "" : "out"} ${d === selected ? "sel" : ""} ${d === t ? "today" : ""}`}
                        data-testid="month-cell"
                        data-date={d}
                        onClick={() => {
                          haptic("light");
                          setSelected(d);
                          if (!inMonth) { setDir(d < `${month}-01` ? -1 : 1); setMonth(monthOf(d)); }
                        }}
                      >
                        <span className={`month-num ${wd === 0 ? "sun" : wd === 6 ? "sat" : ""}`}>{Number(d.slice(8))}</span>
                        {list.slice(0, 3).map((ev) => (
                          <i key={`${ev.calendarId}:${ev.id}`} className="month-ev" style={{ "--ev": evColor(ev, calendars) } as React.CSSProperties}>{ev.title}</i>
                        ))}
                        {list.length > 3 && <i className="month-more">+{list.length - 3}</i>}
                      </button>
                    );
                  })}
                </motion.div>
              </AnimatePresence>
            </div>

            <div className="month-day" data-testid="month-day">
              <div className="month-day-head">
                <strong>{sm}月{sd}日（{WEEK[new Date(sy, sm - 1, sd).getDay()]}）</strong>
                <button className="month-open-day" onClick={() => { haptic("light"); onPickDay(selected); }} data-testid="month-open-day">時間割で見る</button>
                <motion.button
                  className="month-add"
                  whileTap={{ scale: 0.9 }}
                  aria-label="この日に予定を追加"
                  data-testid="month-add"
                  onClick={() => { haptic("light"); onEdit({ mode: "new", date: selected, startMin: selected === t ? Math.min(23 * 60, Math.ceil((new Date().getHours() * 60 + new Date().getMinutes() + 1) / 30) * 30) : 9 * 60 }); }}
                >
                  <Plus size={18} />
                </motion.button>
              </div>
              {sorted.length === 0 && <p className="month-empty">予定はありません</p>}
              <ul className="month-list">
                {sorted.map((ev) => (
                  <li key={`${ev.calendarId}:${ev.id}`}>
                    <button className="month-item" style={{ "--ev": evColor(ev, calendars) } as React.CSSProperties} data-testid="month-event" data-title={ev.title}
                      onClick={() => { haptic("light"); onEdit({ mode: "edit", ev }); }}>
                      <span className="month-item-time">
                        {ev.allDay ? "終日" : ev.start.slice(0, 10) < selected ? "〜" + (ev.end.slice(0, 10) > selected ? "" : hmOf(ev.end)) : hmOf(ev.start)}
                      </span>
                      <span className="month-item-title">{ev.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
