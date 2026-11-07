import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  type CalEvent, connectCalendar, dateLabel, evColor, eventsOn, hmOf, layoutDay, loadDay, relLabel, shiftDate, today, useCal,
} from "../calendar";
import { type MailItem, SLOTS, SLOT_LABEL } from "../mail";
import { haptic } from "../haptics";
import { Calendar, ChevronLeft, ChevronRight, MailIcon } from "./Icons";
import type { EventDraft } from "./EventSheet";

const HOUR = 56; // 1時間の高さ(px)
const EMPTY: CalEvent[] = [];

type Props = {
  /** 下のタブの「今日」が押されるたびに増える。今日の今の時刻の位置まで戻す */
  jump: number;
  /** 見ている日（App が持つ。右下の ＋ とマイクで、この日の予定を入れる） */
  date: string;
  setDate: (d: string) => void;
  unread: MailItem[];
  onOpenMail: () => void;
  onEdit: (d: EventDraft) => void;
};

/** 今日：新着メールのお知らせ + Google カレンダーの1日（縦の時間割） */
export function TodayView({ jump, date, setDate, unread, onOpenMail, onEdit }: Props) {
  const [dir, setDir] = useState(0);
  const source = useCal((s) => s.source);
  const calendars = useCal((s) => s.calendars);
  const dayEvents = useCal((s) => s.days[date] ?? EMPTY);
  const loaded = useCal((s) => date in s.days);
  const failed = useCal((s) => Boolean(s.failed[date]));
  const events = useMemo(() => eventsOn(dayEvents, date), [dayEvents, date]);
  const allDay = events.filter((e) => e.allDay);
  const placed = useMemo(() => layoutDay(events, date, HOUR), [events, date]);
  const isToday = date === today();
  const now = useNow();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  // その日を読み込む（前後の日も先に読んでおくと、日付を動かしたときにすぐ出る）
  useEffect(() => {
    void loadDay(date);
  }, [date]);
  useEffect(() => {
    const onVis = () => document.visibilityState === "visible" && void loadDay(date);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [date]);
  // 日付が変わったら（夜中に開きっぱなし）今日に合わせる
  const todayKey = today();
  const lastToday = useRef(todayKey);
  useEffect(() => {
    if (lastToday.current !== todayKey) {
      if (date === lastToday.current) setDate(todayKey);
      lastToday.current = todayKey;
    }
  }, [todayKey, date]);

  const go = (n: number) => {
    haptic("light");
    setDir(n === 0 ? (date > today() ? -1 : 1) : Math.sign(n));
    setDate(n === 0 ? today() : shiftDate(date, n));
  };

  /* ---------- 時間割の高さ：画面の下まで（中だけスクロールする） ---------- */
  const scroller = useRef<HTMLDivElement>(null);

  /* ---------- 時間割を横にスワイプして日付を動かす（左へ払うと次の日、右へ払うと前の日） ---------- */
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const swiped = useRef(false); // 払った直後のタップで予定の追加が開かないように
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let x0 = 0, y0 = 0, t0 = 0, dx = 0;
    let mode: "h" | "v" | null = null;
    let active = false;
    const start = (e: TouchEvent) => {
      if (e.touches.length !== 1) { active = false; return; }
      active = true; mode = null; dx = 0;
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = performance.now();
    };
    const move = (e: TouchEvent) => {
      if (!active) return;
      const mx = e.touches[0].clientX - x0;
      const my = e.touches[0].clientY - y0;
      if (!mode && (Math.abs(mx) > 10 || Math.abs(my) > 10)) {
        mode = Math.abs(mx) > Math.abs(my) * 1.2 ? "h" : "v";
        if (mode === "h") setDragging(true);
      }
      if (mode !== "h") return;
      e.preventDefault(); // 横に払っている間は縦にスクロールさせない
      dx = mx;
      setDragX(mx * 0.9);
    };
    const end = () => {
      if (!active) return;
      active = false;
      if (mode !== "h") return;
      const v = Math.abs(dx) / Math.max(1, performance.now() - t0);
      if (Math.abs(dx) > 70 || (Math.abs(dx) > 30 && v > 0.45)) {
        swiped.current = true;
        setTimeout(() => { swiped.current = false; }, 350);
        goRef.current(dx < 0 ? 1 : -1);
        setDragX(0); // 次の日の時間割が横から入ってくる（ここは戻す動きを見せない）
        requestAnimationFrame(() => requestAnimationFrame(() => setDragging(false)));
      } else {
        setDragging(false);
        setDragX(0); // 少しだけなら元に戻す
      }
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
  }, [source]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      el.style.setProperty("--tl-top", `${Math.round(top)}px`);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(document.body);
    window.addEventListener("resize", fit);
    return () => { ro.disconnect(); window.removeEventListener("resize", fit); };
  }, [source, allDay.length, unread.length > 0]);

  // 開いたとき・日付を変えたとき：今日なら今の時刻、ほかの日は最初の予定（なければ 8:00）が見える位置へ
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el || scrolledFor.current === `${date}:${loaded}`) return;
    const first = scrolledFor.current === null;
    scrolledFor.current = `${date}:${loaded}`;
    const firstMin = placed.length ? Math.min(...placed.map((p) => p.startMin)) : 8 * 60;
    const target = isToday ? nowMin - 90 : firstMin - 30;
    el.scrollTo({ top: Math.max(0, (target / 60) * HOUR), behavior: first ? "auto" : "smooth" });
  }, [date, loaded, placed, isToday, nowMin]);

  // 下のタブの「今日」を押したら、今の時刻の位置へ（日付は App が今日に戻す）
  const lastJump = useRef(jump);
  useEffect(() => {
    if (lastJump.current === jump) return;
    lastJump.current = jump;
    const el = scroller.current;
    const n = new Date();
    if (el) el.scrollTo({ top: Math.max(0, ((n.getHours() * 60 + n.getMinutes() - 90) / 60) * HOUR), behavior: "smooth" });
  }, [jump]);

  const onTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (swiped.current) return;
    if ((e.target as HTMLElement).closest(".tl-event")) return;
    if (!source || source.status !== "ok") return;
    const r = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - r.top;
    const min = Math.max(0, Math.min(23 * 60 + 30, Math.floor((y / HOUR) * 2) * 30));
    haptic("light");
    onEdit({ mode: "new", date, startMin: min });
  };

  const rel = relLabel(date);

  return (
    <section className="today" data-testid="today">
      <AnimatePresence initial={false}>
        {unread.length > 0 && (
          <motion.button
            key="mail"
            className="today-mail"
            data-testid="mail-banner"
            initial={{ opacity: 0, y: -18, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.96, height: 0, marginBottom: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 26 }}
            whileTap={{ scale: 0.97 }}
            onClick={() => { haptic("light"); onOpenMail(); }}
          >
            <span className="today-mail-icon"><MailIcon size={22} /><i>{unread.length}</i></span>
            <span className="today-mail-text">
              <strong>メールが {unread.length}件 来ています</strong>
              <span className="today-mail-slots">
                {SLOTS.filter((s) => unread.some((m) => m.slot === s)).map((s) => (
                  <b key={s} className={`src-chip src-${s}`} data-testid={`mail-banner-${s}`}>{SLOT_LABEL[s]} {unread.filter((m) => m.slot === s).length}</b>
                ))}
              </span>
            </span>
            <ChevronRight size={18} className="today-mail-chev" />
          </motion.button>
        )}
      </AnimatePresence>

      <div className="day-nav" data-testid="day-nav">
        <motion.button className="day-arrow" whileTap={{ scale: 0.86 }} onClick={() => go(-1)} aria-label="前の日" data-testid="day-prev"><ChevronLeft size={18} /></motion.button>
        <AnimatePresence mode="popLayout" initial={false} custom={dir}>
          <motion.div
            key={date}
            className="day-label"
            custom={dir}
            initial={{ x: 24 * dir, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -24 * dir, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
          >
            <strong data-testid="day-date">{dateLabel(date)}</strong>
            {rel && <span className={`day-rel ${isToday ? "is-today" : ""}`}>{rel}</span>}
          </motion.div>
        </AnimatePresence>
        {!isToday && (
          <motion.button className="day-today" whileTap={{ scale: 0.92 }} onClick={() => go(0)} data-testid="day-today" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>今日</motion.button>
        )}
        <motion.button className="day-arrow" whileTap={{ scale: 0.86 }} onClick={() => go(1)} aria-label="次の日" data-testid="day-next"><ChevronRight size={18} /></motion.button>
      </div>

      {source === null && (
        <div className="cal-connect" data-testid="cal-connect-card">
          <motion.div className="cal-hero" initial={{ scale: 0.6, rotate: -8 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 300, damping: 16 }}>
            <Calendar size={32} />
          </motion.div>
          <h3>Googleカレンダーをつなぐ</h3>
          <p>個人のGoogleアカウントを選んでください。今日の予定がここに並び、Flick から追加・変更・削除できます。</p>
          <motion.button className="primary-btn" whileTap={{ scale: 0.96 }} onClick={connectCalendar} data-testid="cal-connect">カレンダーをつなぐ</motion.button>
        </div>
      )}

      {source?.status === "expired" && (
        <div className="cal-connect expired" data-testid="cal-expired">
          <h3>カレンダーとの接続が切れました</h3>
          <p>Googleのアプリが「テスト中」のあいだは、7日ごとにつなぎ直しが必要です。</p>
          <motion.button className="primary-btn" whileTap={{ scale: 0.96 }} onClick={connectCalendar} data-testid="cal-reconnect">つなぎ直す</motion.button>
        </div>
      )}

      {source !== null && source?.status !== "expired" && (
        <>
          {allDay.length > 0 && (
            <ul className="allday" data-testid="allday">
              {allDay.map((ev) => (
                <li key={`${ev.calendarId}:${ev.id}`}>
                  <button className="allday-ev" style={{ "--ev": evColor(ev, calendars) } as React.CSSProperties} data-testid="event" data-title={ev.title}
                    onClick={() => { haptic("light"); onEdit({ mode: "edit", ev }); }}>
                    {ev.title}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="tl-scroll" ref={scroller} data-testid="timeline-scroll">
            <div className={`tl-drag ${dragging ? "dragging" : ""}`} style={{ transform: dragX ? `translateX(${dragX}px)` : undefined, opacity: dragX ? Math.max(0.55, 1 - Math.abs(dragX) / 500) : undefined }}>
            <motion.div
              key={date}
              className="timeline"
              style={{ height: 24 * HOUR }}
              onClick={onTimelineClick}
              data-testid="timeline"
              data-date={date}
              initial={dir ? { x: dir * 56, opacity: 0.3 } : false}
              animate={{ x: 0, opacity: 1 }}
              transition={{ type: "spring", stiffness: 420, damping: 36 }}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="tl-hour" style={{ top: h * HOUR }}>
                  <span>{h === 0 ? "" : `${h}:00`}</span>
                </div>
              ))}

              {!loaded && source === undefined && (
                <div className="tl-skeleton" aria-label="予定を読み込んでいます">
                  <div className="sk" style={{ top: 9.5 * HOUR, height: HOUR * 1.4 }} />
                  <div className="sk" style={{ top: 13 * HOUR, height: HOUR * 1.4 }} />
                </div>
              )}

              <AnimatePresence initial={false}>
                {placed.map((p, i) => {
                  const past = isToday && p.endMin <= nowMin;
                  const short = p.height < 40;
                  return (
                    <motion.button
                      key={`${p.ev.calendarId}:${p.ev.id}`}
                      layout="position"
                      className={`tl-event ${past ? "past" : ""} ${short ? "short" : ""}`}
                      data-testid="event"
                      data-title={p.ev.title}
                      style={{
                        top: p.top, height: p.height,
                        left: `calc(var(--tl-gutter) + (100% - var(--tl-gutter) - 6px) * ${p.col / p.cols})`,
                        width: `calc((100% - var(--tl-gutter) - 6px) / ${p.cols} - 3px)`,
                        "--ev": evColor(p.ev, calendars),
                      } as React.CSSProperties}
                      initial={{ opacity: 0, scale: 0.94 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.94 }}
                      transition={{ type: "spring", stiffness: 420, damping: 30, delay: Math.min(i, 8) * 0.03 }}
                      onClick={() => { haptic("light"); onEdit({ mode: "edit", ev: p.ev }); }}
                    >
                      <span className="tl-ev-title">{p.ev.title}</span>
                      <span className="tl-ev-time">{p.ev.start.slice(0, 10) < date ? "〜" : hmOf(p.ev.start)}{short ? "" : `〜${p.ev.end.slice(0, 10) > date ? "" : hmOf(p.ev.end)}`}</span>
                      {!short && p.ev.location && <span className="tl-ev-loc">{p.ev.location}</span>}
                    </motion.button>
                  );
                })}
              </AnimatePresence>

              {isToday && (
                <div className="tl-now" style={{ top: (nowMin / 60) * HOUR }} data-testid="now-line" aria-hidden="true">
                  <i />
                </div>
              )}
            </motion.div>
            </div>
          </div>
          {loaded && events.length === 0 && (
            <p className="tl-empty" data-testid="day-empty">{rel ? `${rel}の予定はありません` : "予定はありません"}。空いている時間を押すと追加できます。</p>
          )}
          {failed && !loaded && <p className="tl-empty">予定を読み込めませんでした（オフラインかもしれません）</p>}
        </>
      )}
    </section>
  );
}

/** 1分ごとに更新される「今」 */
function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    const t = setTimeout(function loop() { tick(); timer = setTimeout(loop, 60_000); }, 60_000 - (Date.now() % 60_000));
    let timer = t;
    const onVis = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", onVis);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", onVis); };
  }, []);
  return now;
}
