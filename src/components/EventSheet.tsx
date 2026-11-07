import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useDragControls } from "motion/react";
import {
  type CalEvent, CalWriteError, atMinutes, createEvent, dateLabel, deleteEvent, shiftDate, updateEvent, useCal, writeErrorText,
} from "../calendar";
import { haptic } from "../haptics";
import { Trash } from "./Icons";

export type EventDraft = { mode: "new"; date: string; startMin: number } | { mode: "edit"; ev: CalEvent };
type Props = { draft: EventDraft | null; onClose: () => void; toast: (text: string) => void };

type Form = {
  title: string; allDay: boolean; date: string; endDate: string; startTime: string; endTime: string;
  location: string; description: string; calendarId: string;
};

function initialForm(d: EventDraft, defaultCal: string): Form {
  if (d.mode === "new") {
    const s = atMinutes(d.date, d.startMin);
    const e = atMinutes(d.date, Math.min(d.startMin + 60, 1439));
    return { title: "", allDay: false, date: d.date, endDate: d.date, startTime: s.slice(11), endTime: e.slice(11), location: "", description: "", calendarId: defaultCal };
  }
  const ev = d.ev;
  return {
    title: ev.title, allDay: ev.allDay,
    date: ev.start.slice(0, 10),
    // 終日の終わりは「含まない日」で持っているので、画面では前日（最後の日）にして見せる
    endDate: ev.allDay ? shiftDate(ev.end.slice(0, 10), -1) : ev.end.slice(0, 10),
    startTime: ev.allDay ? "09:00" : ev.start.slice(11, 16),
    endTime: ev.allDay ? "10:00" : ev.end.slice(11, 16),
    location: ev.location, description: ev.description, calendarId: ev.calendarId,
  };
}

/** 予定の追加・変更・削除（Google カレンダーに直接書き込む） */
export function EventSheet({ draft, onClose, toast }: Props) {
  const calendars = useCal((s) => s.calendars);
  const writable = useMemo(() => calendars.filter((c) => c.writable), [calendars]);
  const defaultCal = writable.find((c) => c.primary)?.id ?? writable[0]?.id ?? "primary";
  const drag = useDragControls();
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [error, setError] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!draft) { setForm(null); return; }
    setForm(initialForm(draft, defaultCal));
    setSaving(false);
    setConfirmDel(false);
    setError("");
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.documentElement.classList.add("sheet-open");
    if (draft.mode === "new") setTimeout(() => titleRef.current?.focus(), 60);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.documentElement.classList.remove("sheet-open");
    };
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const ev = draft?.mode === "edit" ? draft.ev : null;
  const readOnly = Boolean(ev && !ev.editable);
  const up = (p: Partial<Form>) => setForm((f) => (f ? { ...f, ...p } : f));

  const toInput = (f: Form) => {
    const start = f.allDay ? f.date : `${f.date}T${f.startTime}`;
    let end = f.allDay ? shiftDate(f.endDate < f.date ? f.date : f.endDate, 1) : `${f.endDate < f.date ? f.date : f.endDate}T${f.endTime}`;
    // 終わりが始まり以前なら、日をまたぐ予定とみなす（例：22:00〜2:00）
    if (!f.allDay && end <= start) end = `${shiftDate(f.date, 1)}T${f.endTime}`;
    return { calendarId: f.calendarId, title: f.title.trim(), start, end, allDay: f.allDay, location: f.location.trim(), description: f.description };
  };

  const save = async () => {
    if (!form || !form.title.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      if (ev) await updateEvent(ev, toInput(form));
      else await createEvent(toInput(form));
      haptic("success");
      toast(ev ? "予定を変更しました" : "予定を追加しました");
      onClose();
    } catch (e) {
      setError(writeErrorText(e instanceof CalWriteError ? e.code : "error"));
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!ev) return;
    if (!confirmDel) { haptic("light"); setConfirmDel(true); return; }
    setSaving(true);
    try {
      await deleteEvent(ev);
      haptic("success");
      toast("予定を削除しました");
      onClose();
    } catch (e) {
      setError(writeErrorText(e instanceof CalWriteError ? e.code : "error"));
      setSaving(false);
    }
  };

  const calName = (id: string) => calendars.find((c) => c.id === id)?.title || "カレンダー";

  return (
    <AnimatePresence>
      {draft && form && (
        <>
          <motion.div key="scrim" className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.section
            key="sheet"
            className="sheet glass event-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={ev ? "予定の詳細" : "予定を追加"}
            data-testid="event-sheet"
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
            <div className="grabber-zone" onPointerDown={(e) => drag.start(e)}><div className="grabber" /></div>

            <div className="event-cal-row">
              <i className="event-cal-dot" style={{ background: ev?.color ?? calendars.find((c) => c.id === form.calendarId)?.color ?? "var(--blue)" }} />
              <span>{calName(form.calendarId)}</span>
              {ev?.recurring && !readOnly && <em>繰り返しの予定：この日の1回だけ変わります</em>}
            </div>

            <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
              <input
                ref={titleRef}
                className="sheet-title event-title"
                value={form.title}
                placeholder="タイトル"
                aria-label="予定のタイトル"
                data-testid="event-title"
                enterKeyHint="done"
                readOnly={readOnly}
                onChange={(e) => up({ title: e.target.value })}
              />

              <div className="event-fields">
                <label className="event-row">
                  <span>終日</span>
                  <input type="checkbox" role="switch" className="switch" checked={form.allDay} disabled={readOnly} data-testid="event-allday" onChange={(e) => up({ allDay: e.target.checked })} />
                </label>
                <div className="event-row">
                  <span>開始</span>
                  <div className="event-when">
                    <label className="event-pill">
                      {dateLabel(form.date)}
                      <input type="date" aria-label="開始日" data-testid="event-date" value={form.date} disabled={readOnly}
                        onChange={(e) => e.target.value && up({ date: e.target.value, endDate: e.target.value > form.endDate ? e.target.value : form.endDate })} />
                    </label>
                    {!form.allDay && (
                      <label className="event-pill time">
                        {form.startTime}
                        <input type="time" step={300} aria-label="開始時刻" data-testid="event-start" value={form.startTime} disabled={readOnly}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (!v) return;
                            // 開始をずらしたら、長さを保ったまま終わりも動かす
                            const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
                            const len = Math.max(15, toMin(form.endTime) - toMin(form.startTime));
                            const endMin = Math.min(toMin(v) + len, 1439);
                            up({ startTime: v, endTime: atMinutes(form.date, endMin).slice(11) });
                          }} />
                      </label>
                    )}
                  </div>
                </div>
                <div className="event-row">
                  <span>終了</span>
                  <div className="event-when">
                    {(form.allDay || form.endDate !== form.date) && (
                      <label className="event-pill">
                        {dateLabel(form.endDate)}
                        <input type="date" aria-label="終了日" data-testid="event-end-date" value={form.endDate} min={form.date} disabled={readOnly}
                          onChange={(e) => e.target.value && up({ endDate: e.target.value })} />
                      </label>
                    )}
                    {!form.allDay && (
                      <label className="event-pill time">
                        {form.endTime}
                        <input type="time" step={300} aria-label="終了時刻" data-testid="event-end" value={form.endTime} disabled={readOnly}
                          onChange={(e) => e.target.value && up({ endTime: e.target.value })} />
                      </label>
                    )}
                  </div>
                </div>
                {!ev && writable.length > 1 && (
                  <div className="event-row cal-pick">
                    <span>カレンダー</span>
                    <div className="chips">
                      {writable.map((c) => (
                        <button type="button" key={c.id} className={`chip ${form.calendarId === c.id ? "on" : ""}`} onClick={() => up({ calendarId: c.id })}>
                          <i className="event-cal-dot" style={{ background: c.color }} />{c.title}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <input
                className="sheet-note event-input"
                value={form.location}
                placeholder="場所"
                aria-label="場所"
                data-testid="event-location"
                readOnly={readOnly}
                onChange={(e) => up({ location: e.target.value })}
              />
              <textarea
                className="sheet-note"
                value={form.description}
                placeholder="メモ"
                rows={2}
                aria-label="メモ"
                data-testid="event-note"
                readOnly={readOnly}
                onChange={(e) => up({ description: e.target.value })}
              />

              {readOnly && <p className="event-readonly" data-testid="event-readonly">このカレンダーの予定は見るだけです（Flick からは変更できません）</p>}
              {error && <p className="event-error" role="alert" data-testid="event-error">{error}</p>}

              {!readOnly && (
                <div className="sheet-actions">
                  <motion.button type="submit" className="primary-btn" whileTap={{ scale: 0.96 }} disabled={!form.title.trim() || saving} data-testid="event-save">
                    {saving && !confirmDel ? "保存しています…" : ev ? "変更を保存" : "予定を追加"}
                  </motion.button>
                  {ev && (
                    <motion.button
                      type="button"
                      className={`del-btn ${confirmDel ? "confirm" : ""}`}
                      whileTap={{ scale: 0.95 }}
                      aria-label={confirmDel ? "もう一度押すと削除" : "予定を削除"}
                      data-testid="event-delete"
                      disabled={saving && !confirmDel}
                      onClick={() => void remove()}
                      layout
                    >
                      <Trash size={19} />
                      {confirmDel && <span>削除する</span>}
                    </motion.button>
                  )}
                </div>
              )}
            </form>
          </motion.section>
        </>
      )}
    </AnimatePresence>
  );
}
