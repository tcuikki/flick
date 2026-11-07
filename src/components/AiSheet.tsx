import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useDragControls } from "motion/react";
import { STATUS_LABEL, type PlannedTask, addPlanned, planWithAi, transcribeAudio } from "../store";
import { dueLabel } from "../date";
import { haptic } from "../haptics";
import { strangeKanji } from "../kanji";
import { Mic, Sparkle, Stop } from "./Icons";

type Props = {
  open: boolean;
  onClose: () => void;
  onAdded: (count: number) => void;
};

type Draft = PlannedTask & { on: boolean };
const MAX_SEC = 90;

/** 状況を話す（または書く）→ AI がタスクに分ける → 確かめて追加 */
export function AiSheet({ open, onClose, onAdded }: Props) {
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

  const patch = (i: number, p: Partial<Draft>) => setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...p } : d)));
  const count = drafts.filter((d) => d.on && d.title.trim()).length;
  const busy = phase === "transcribing" || phase === "thinking";

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div key="scrim" className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => !busy && onClose()} />
          <motion.section
            key="sheet"
            className="sheet glass ai-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="AIに頼む"
            data-testid="ai-sheet"
            drag="y"
            dragControls={drag}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0.04, bottom: 0.7 }}
            onDragEnd={(_, i) => !busy && (i.offset.y > 110 || i.velocity.y > 650) && onClose()}
            initial={{ y: "100%", scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: "105%", scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 36, mass: 0.9 }}
          >
            <div className="grabber-zone" onPointerDown={(e) => drag.start(e)}>
              <div className="grabber" />
            </div>

            <div className="ai-head">
              <Sparkle size={18} className="ai-head-icon" />
              <span>{phase === "review" ? "この内容で追加しますか？" : "今の状況を話してください"}</span>
            </div>

            {phase !== "review" ? (
              <>
                <textarea
                  ref={textRef}
                  className="sheet-note ai-text"
                  rows={5}
                  value={text}
                  placeholder="例：明日の10時から面接があるので、その前に企業研究をしたい。レポートは今書いている途中で、金曜までに出す"
                  aria-label="状況"
                  data-testid="ai-text"
                  disabled={busy}
                  onChange={(e) => setText(e.target.value)}
                />

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
                  <div className="ai-status" aria-live="polite" data-testid="ai-status">
                    {phase === "recording" && <>聞いています… {Math.floor(sec / 60)}:{String(sec % 60).padStart(2, "0")}（もう一度押すと止まります）</>}
                    {phase === "transcribing" && "文字にしています…"}
                    {phase === "thinking" && "タスクに分けています…"}
                    {phase === "input" && !error && "マイクを押して話すか、文字で書いてください"}
                    {phase === "input" && error && <span className="ai-error">{error}</span>}
                  </div>
                </div>

                <motion.button
                  type="button"
                  className={`ai-btn ${busy ? "busy" : ""}`}
                  disabled={!text.trim() || phase !== "input"}
                  whileTap={{ scale: 0.96 }}
                  data-testid="ai-plan"
                  onClick={think}
                >
                  <Sparkle size={17} />
                  <span>{phase === "thinking" ? "考えています…" : "タスクにする"}</span>
                </motion.button>
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
          </motion.section>
        </>
      )}
    </AnimatePresence>
  );
}
