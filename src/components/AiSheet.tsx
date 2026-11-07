import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useDragControls } from "motion/react";
import { STATUS_LABEL, type PlannedTask, addPlanned, planWithAi, transcribeAudio } from "../store";
import {
  type PlannedEvent, CalWriteError, MAIN_COLORS, colorChoice, createEvent, dateLabel, planEventsWithAi, shiftDate, suggestColor, today, writeErrorText,
} from "../calendar";
import { dueLabel } from "../date";
import { haptic } from "../haptics";
import { strangeKanji } from "../kanji";
import { Mic, Sparkle, Stop } from "./Icons";

type Props = {
  open: boolean;
  /** tasks = タスクに分ける（タスクのページ）、events = 予定にする（今日のページ） */
  mode?: "tasks" | "events";
  /** events のとき、日付を言わなかった予定の日（今日のページで見ている日） */
  baseDate?: string;
  onClose: () => void;
  onAdded: (count: number) => void;
};

type Draft = PlannedTask & { on: boolean };
type EventDraft = PlannedEvent & { on: boolean; colorId: string };
const MAX_SEC = 90;

/** 状況を話す（または書く）→ AI がタスクに分ける → 確かめて追加 */
export function AiSheet({ open, mode = "tasks", baseDate, onClose, onAdded }: Props) {
  const isEvents = mode === "events";
  const [evDrafts, setEvDrafts] = useState<EventDraft[]>([]);
  const [adding, setAdding] = useState(false);
  const drag = useDragControls();
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"input" | "recording" | "transcribing" | "thinking" | "review">("input");
  const [sec, setSec] = useState(0);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [source, setSource] = useState("");
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; timer: number } | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const stopTracks = () => {
    const r = rec.current;
    if (!r) return;
    clearInterval(r.timer);
    r.stream.getTracks().forEach((t) => t.stop());
  };

  useEffect(() => {
    if (!open) return;
    setText("");
    setPhase("input");
    setError("");
    setDrafts([]);
    setEvDrafts([]);
    setAdding(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.documentElement.classList.add("sheet-open");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.documentElement.classList.remove("sheet-open");
      // 閉じたら録音も止める
      if (rec.current?.mr.state === "recording") rec.current.mr.onstop = null;
      try { rec.current?.mr.state === "recording" && rec.current.mr.stop(); } catch { /* noop */ }
      stopTracks();
      rec.current = null;
    };
  }, [open, onClose]);

  const startRec = useCallback(async () => {
    setError("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("この端末では録音できません。キーボードのマイクで話してください");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("マイクが使えませんでした。設定でマイクを許可するか、キーボードのマイクで話してください");
      return;
    }
    const type = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((t) => MediaRecorder.isTypeSupported?.(t));
    const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = async () => {
      stopTracks();
      const blob = new Blob(chunks, { type: mr.mimeType || type || "audio/webm" });
      rec.current = null;
      if (!blob.size) { setPhase("input"); return; }
      setPhase("transcribing");
      try {
        const said = await transcribeAudio(blob);
        if (said) setText((t) => (t.trim() ? `${t.trim()}\n${said}` : said));
        else setError("うまく聞き取れませんでした。もう一度話してください");
      } catch {
        setError("文字にできませんでした。キーボードのマイクで話してください");
      }
      setPhase("input");
    };
    const started = Date.now();
    const timer = window.setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setSec(s);
      if (s >= MAX_SEC && mr.state === "recording") mr.stop();
    }, 250);
    rec.current = { mr, stream, chunks, timer };
    setSec(0);
    mr.start();
    haptic("light");
    setPhase("recording");
  }, []);

  const stopRec = () => {
    haptic();
    try { rec.current?.mr.stop(); } catch { setPhase("input"); }
  };

  const think = async () => {
    const said = text.trim();
    if (!said) return;
    setError("");
    setPhase("thinking");
    if (isEvents) {
      try {
        const list = await planEventsWithAi(said, baseDate ?? today());
        if (!list.length) {
          setError("予定が見つかりませんでした。日にちや時間と一緒に言い直してください");
          setPhase("input");
          return;
        }
        setSource(said);
        setEvDrafts(list.map((e) => ({ ...e, on: true, colorId: suggestColor(e.title) })));
        haptic("success");
        setPhase("review");
      } catch {
        setError("AIに接続できませんでした。少し待ってからもう一度押してください");
        setPhase("input");
      }
      return;
    }
    try {
      const list = await planWithAi(said);
      if (!list.length) {
        setError("タスクが見つかりませんでした。やることを言い直してください");
        setPhase("input");
        return;
      }
      setSource(said);
      setDrafts(list.map((t) => ({ ...t, on: true })));
      haptic("success");
      setPhase("review");
    } catch {
      setError("AIに接続できませんでした。少し待ってからもう一度押してください");
      setPhase("input");
    }
  };

  const add = () => {
    const chosen = drafts.filter((d) => d.on && d.title.trim()).map(({ on, ...t }) => ({ ...t, title: t.title.trim() }));
    if (!chosen.length) return;
    addPlanned(chosen);
    haptic("success");
    onAdded(chosen.length);
  };

  /** 予定を Google カレンダーへ（1件ずつ。失敗したらそこで止めて知らせる） */
  const addEvents = async () => {
    const chosen = evDrafts.filter((d) => d.on && d.title.trim());
    if (!chosen.length || adding) return;
    setAdding(true);
    setError("");
    let done = 0;
    for (const d of chosen) {
      try {
        await createEvent({
          calendarId: "primary",
          title: d.title.trim(),
          start: d.all_day ? d.date : `${d.date}T${d.start}`,
          end: d.all_day ? shiftDate(d.end_date, 1) : `${d.end_date}T${d.end}`,
          allDay: d.all_day,
          location: d.location,
          description: "",
          colorId: d.colorId,
        });
        done++;
      } catch (e) {
        setError(`${done ? `${done}件は追加しました。` : ""}${writeErrorText(e instanceof CalWriteError ? e.code : "error")}`);
        setEvDrafts((ds) => ds.filter((x) => !chosen.slice(0, done).includes(x)));
        setAdding(false);
        return;
      }
    }
    haptic("success");
    setAdding(false);
    onAdded(done);
  };

  const patch = (i: number, p: Partial<Draft>) => setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...p } : d)));
  const patchEv = (i: number, p: Partial<EventDraft>) => setEvDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...p } : d)));
  const count = isEvents ? evDrafts.filter((d) => d.on && d.title.trim()).length : drafts.filter((d) => d.on && d.title.trim()).length;
  const busy = phase === "transcribing" || phase === "thinking" || adding;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div key="scrim" className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => !busy && onClose()} />
          <motion.section
            key="sheet"
            className="sheet sheet-top glass ai-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={isEvents ? "話して予定を入れる" : "AIに頼む"}
            data-testid="ai-sheet"
            drag="y"
            dragControls={drag}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0.7, bottom: 0.04 }}
            onDragEnd={(_, i) => !busy && (i.offset.y < -90 || i.velocity.y < -650) && onClose()}
            initial={{ y: "-105%", scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: "-110%", scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 36, mass: 0.9 }}
          >

            <div className="ai-head">
              <Sparkle size={18} className="ai-head-icon" />
              <span>{phase === "review" ? (isEvents ? "この予定を入れますか？" : "この内容で追加しますか？") : isEvents ? "入れたい予定を話してください" : "今の状況を話してください"}</span>
            </div>

            {phase !== "review" ? (
              <>
                <textarea
                  ref={textRef}
                  className="sheet-note ai-text"
                  rows={3}
                  value={text}
                  placeholder={isEvents
                    ? "例：明日の10時から12時までアルファシステムズの面接。土曜の17時からニトリでバイト"
                    : "例：明日の10時から面接があるので、その前に企業研究をしたい。レポートは今書いている途中で、金曜までに出す"}
                  aria-label="状況"
                  data-testid="ai-text"
                  disabled={busy}
                  onChange={(e) => setText(e.target.value)}
                />

                <div className="ai-status" aria-live="polite" data-testid="ai-status">
                  {phase === "recording" && <>聞いています… {Math.floor(sec / 60)}:{String(sec % 60).padStart(2, "0")}（もう一度押すと止まります）</>}
                  {phase === "transcribing" && "文字にしています…"}
                  {phase === "thinking" && (isEvents ? "予定にしています…" : "タスクに分けています…")}
                  {phase === "input" && !error && "マイクを押して話すか、文字で書いてください"}
                  {phase === "input" && error && <span className="ai-error">{error}</span>}
                </div>
                <div className="ai-controls">
                  <motion.button
                    type="button"
                    className={`mic-btn ${phase === "recording" ? "rec" : ""}`}
                    aria-label={phase === "recording" ? "録音を止める" : "話す"}
                    data-testid="mic"
                    disabled={busy}
                    whileTap={{ scale: 0.9 }}
                    onClick={() => (phase === "recording" ? stopRec() : void startRec())}
                  >
                    {phase === "recording" && <span className="mic-pulse" aria-hidden="true" />}
                    {phase === "recording" ? <Stop size={22} /> : <Mic size={24} />}
                  </motion.button>
                  <motion.button
                    type="button"
                    className={`ai-btn ${busy ? "busy" : ""}`}
                    disabled={!text.trim() || phase !== "input"}
                    whileTap={{ scale: 0.96 }}
                    data-testid="ai-plan"
                    onClick={think}
                  >
                    <Sparkle size={17} />
                    <span>{phase === "thinking" ? "考えています…" : isEvents ? "予定にする" : "タスクにする"}</span>
                  </motion.button>
                </div>
              </>
            ) : isEvents ? (
              <>
                <ul className="plan-list" data-testid="plan-list">
                  {evDrafts.map((d, i) => {
                    const odd = strangeKanji(d.title, source);
                    const c = colorChoice(d.colorId);
                    return (
                      <motion.li
                        key={i}
                        className={`plan-item ${d.on ? "" : "off"}`}
                        data-testid="plan-event"
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.05, type: "spring", stiffness: 420, damping: 32 }}
                      >
                        <input type="checkbox" className="plan-check" checked={d.on} aria-label="この予定を入れる" onChange={(e) => patchEv(i, { on: e.target.checked })} />
                        <div className="plan-body">
                          <input className="plan-title" value={d.title} aria-label="予定の名前" data-testid="plan-title" onChange={(e) => patchEv(i, { title: e.target.value })} />
                          <div className="plan-meta">
                            <label className="plan-due" data-testid="plan-date">
                              {dateLabel(d.date)}
                              <input type="date" aria-label="日付" value={d.date}
                                onChange={(e) => e.target.value && patchEv(i, { date: e.target.value, end_date: d.end_date === d.date ? e.target.value : d.end_date < e.target.value ? e.target.value : d.end_date })} />
                            </label>
                            {d.all_day ? (
                              <button type="button" className="plan-due" data-testid="plan-time" onClick={() => patchEv(i, { all_day: false, start: "09:00", end: "10:00" })}>終日</button>
                            ) : (
                              <>
                                <label className="plan-due" data-testid="plan-time">
                                  {Number(d.start!.slice(0, 2))}:{d.start!.slice(3)}
                                  <input type="time" step={300} aria-label="開始時刻" value={d.start!} onChange={(e) => e.target.value && patchEv(i, { start: e.target.value })} />
                                </label>
                                <span className="plan-tilde">〜</span>
                                <label className="plan-due" data-testid="plan-end">
                                  {d.end_date !== d.date && `${dateLabel(d.end_date).replace(/（.）/, "")} `}{Number(d.end!.slice(0, 2))}:{d.end!.slice(3)}
                                  <input type="time" step={300} aria-label="終了時刻" value={d.end!} onChange={(e) => e.target.value && patchEv(i, { end: e.target.value })} />
                                </label>
                              </>
                            )}
                            <button
                              type="button"
                              className="plan-color"
                              style={{ "--c": c.hex } as React.CSSProperties}
                              data-testid="plan-color"
                              aria-label={`色：${c.use || c.name}（押すと変わる）`}
                              onClick={() => {
                                const k = MAIN_COLORS.findIndex((x) => x.id === d.colorId);
                                patchEv(i, { colorId: MAIN_COLORS[(k + 1) % MAIN_COLORS.length].id });
                              }}
                            >
                              <i />{c.use || c.name}
                            </button>
                            {d.location && <span className="plan-note">{d.location}</span>}
                            {odd.length > 0 && (
                              <span className="plan-warn" data-testid="plan-warn" title="話した内容に無い漢字が入っています">字を確認：{odd.join("")}</span>
                            )}
                          </div>
                        </div>
                      </motion.li>
                    );
                  })}
                </ul>
                {error && <p className="event-error" role="alert" data-testid="ai-error">{error}</p>}
                <div className="sheet-actions">
                  <motion.button type="button" className="ghost-btn" whileTap={{ scale: 0.96 }} disabled={adding} onClick={() => setPhase("input")} data-testid="ai-back">
                    言い直す
                  </motion.button>
                  <motion.button type="button" className="primary-btn" disabled={!count || adding} whileTap={{ scale: 0.96 }} onClick={() => void addEvents()} data-testid="ai-add">
                    {adding ? "入れています…" : `${count}件を予定に入れる`}
                  </motion.button>
                </div>
              </>
            ) : (
              <>
                <ul className="plan-list" data-testid="plan-list">
                  {drafts.map((d, i) => {
                    const odd = strangeKanji(d.title, source);
                    return (
                      <motion.li
                        key={i}
                        className={`plan-item ${d.on ? "" : "off"}`}
                        data-testid="plan-item"
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.05, type: "spring", stiffness: 420, damping: 32 }}
                      >
                        <input
                          type="checkbox"
                          className="plan-check"
                          checked={d.on}
                          aria-label="このタスクを追加する"
                          onChange={(e) => patch(i, { on: e.target.checked })}
                        />
                        <div className="plan-body">
                          <input
                            className="plan-title"
                            value={d.title}
                            aria-label="タスク名"
                            data-testid="plan-title"
                            onChange={(e) => patch(i, { title: e.target.value })}
                          />
                          <div className="plan-meta">
                            <button
                              type="button"
                              className={`plan-status s-${d.status}`}
                              onClick={() => patch(i, { status: d.status === "doing" ? "todo" : "doing" })}
                            >
                              {STATUS_LABEL[d.status]}
                            </button>
                            <label className="plan-due">
                              {d.due_date ? dueLabel(d.due_date).text : "期限なし"}
                              <input type="date" aria-label="期限日" value={d.due_date ?? ""} onChange={(e) => patch(i, { due_date: e.target.value || null })} />
                            </label>
                            {d.note && <span className="plan-note">{d.note}</span>}
                            {odd.length > 0 && (
                              <span className="plan-warn" data-testid="plan-warn" title="話した内容に無い漢字が入っています">
                                字を確認：{odd.join("")}
                              </span>
                            )}
                          </div>
                        </div>
                      </motion.li>
                    );
                  })}
                </ul>
                <div className="sheet-actions">
                  <motion.button type="button" className="ghost-btn" whileTap={{ scale: 0.96 }} onClick={() => setPhase("input")} data-testid="ai-back">
                    言い直す
                  </motion.button>
                  <motion.button type="button" className="primary-btn" disabled={!count} whileTap={{ scale: 0.96 }} onClick={add} data-testid="ai-add">
                    {count}件を追加
                  </motion.button>
                </div>
              </>
            )}
            <div className="grabber-zone bottom" onPointerDown={(e) => drag.start(e)}>
              <div className="grabber" />
            </div>
          </motion.section>
        </>
      )}
    </AnimatePresence>
  );
}
