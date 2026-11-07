import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useDragControls, useMotionValue, useTransform } from "motion/react";
import {
  type MailItem, type Slot, SLOTS, SLOT_LABEL,
  connectSlot, dayTimeLabel, disconnectSlot, fullTime, listTime, markOpened, nextUpdateLabel, refreshMailNow, setRead, useMail,
} from "../mail";
import { addPlanned } from "../store";
import { dueLabel } from "../date";
import { haptic } from "../haptics";
import { strangeKanji } from "../kanji";
import { Check, ChevronLeft, MailIcon, Refresh, Sparkle } from "./Icons";

type Props = { open: boolean; onClose: () => void; toast: (text: string) => void };

const SWIPE = 80;

/** メールの枠（未着手・進行中・完了とは別）。個人・事業・大学の受信箱を新着順に、未読・既読つきで見せる */
export function MailView({ open, onClose, toast }: Props) {
  const sources = useMail((s) => s.sources);
  const items = useMail((s) => s.items);
  const checking = useMail((s) => s.checking);
  const outlookReady = useMail((s) => s.outlookReady);
  const [slot, setSlot] = useState<Slot>("personal");
  const [detail, setDetail] = useState<MailItem | null>(null);
  const detailRef = useRef<MailItem | null>(null);
  detailRef.current = detail;

  useEffect(() => {
    if (!open) return;
    // 未読があるところを最初に開く
    const first = SLOTS.find((s) => items.some((m) => m.slot === s && !m.read)) ?? SLOTS.find((s) => sources.some((x) => x.slot === s)) ?? "personal";
    setSlot(first);
    document.documentElement.classList.add("mail-open");
    // 中身を開いているときの Esc は中身だけ閉じる（最新の状態を ref で見る）
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (detailRef.current ? setDetail(null) : onClose());
    window.addEventListener("keydown", onKey);
    return () => {
      document.documentElement.classList.remove("mail-open");
      window.removeEventListener("keydown", onKey);
      markOpened(); // 閉じたら「見た」ことにして、一覧の上のお知らせを消す
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const src = sources.find((s) => s.slot === slot) ?? null;
  const list = items.filter((m) => m.slot === slot).sort((a, b) => b.date - a.date);
  const unread = (s: Slot) => items.filter((m) => m.slot === s && !m.read).length;
  const lastUpdate = Math.max(0, ...sources.map((s) => s.checked_at ?? 0));

  return (
    <AnimatePresence>
      {open && (
        <motion.section
          className="mail-view"
          role="dialog"
          aria-modal="true"
          aria-label="メール"
          data-testid="mail-view"
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ type: "spring", stiffness: 380, damping: 38 }}
        >
          <header className="mail-head glass">
            <motion.button className="mail-back" whileTap={{ scale: 0.88 }} onClick={onClose} aria-label="戻る" data-testid="mail-close">
              <ChevronLeft size={22} />
            </motion.button>
            <div className="mail-head-text">
              <h2>メール</h2>
              <span data-testid="mail-updated">
                {lastUpdate ? `${dayTimeLabel(lastUpdate)} に更新・次は ${nextUpdateLabel()}` : `毎日 10:00 と 20:00 に更新`}
              </span>
            </div>
            {sources.length > 0 && (
              <motion.button
                className={`mail-refresh ${checking ? "spin" : ""}`}
                whileTap={{ scale: 0.88 }}
                disabled={checking}
                aria-label="今すぐ更新"
                data-testid="mail-check"
                onClick={async () => { haptic("light"); toast(await refreshMailNow()); }}
              >
                <Refresh size={19} />
              </motion.button>
            )}
          </header>

          <div className="mail-body">
            <div className="seg mail-seg" role="tablist" aria-label="メールの種類">
              {SLOTS.map((s) => (
                <button key={s} role="tab" aria-selected={slot === s} className={`seg-btn ${slot === s ? "on" : ""}`} data-testid={`mail-tab-${s}`} onClick={() => { haptic(); setSlot(s); }}>
                  {slot === s && <motion.span layoutId="mail-seg-pill" className={`seg-pill src-${s}`} transition={{ type: "spring", stiffness: 520, damping: 34 }} />}
                  <span>
                    {SLOT_LABEL[s]}
                    {unread(s) > 0 && <b className="tab-unread" data-testid={`mail-unread-${s}`}>{unread(s)}</b>}
                  </span>
                </button>
              ))}
            </div>

            {!src && <ConnectCard slot={slot} ready={slot !== "univ" || outlookReady} />}
            {src?.status === "expired" && <ExpiredCard slot={slot} />}
            {src?.status === "ok" && (
              <>
                <div className="mail-count" data-testid="mail-count">
                  <b>未読 {unread(slot)}件</b>
                  <span>受信箱の新しい{list.length}件</span>
                </div>
                {list.length === 0 && <div className="mail-empty" data-testid="mail-none">まだメールを読み込んでいません。右上の ↻ で今すぐ更新できます。</div>}
                {list.length > 0 && (
                  <ul className="mail-list" data-testid="mail-list">
                    <AnimatePresence initial={false}>
                      {list.map((m, i) => (
                        <MailRow key={m.id} m={m} i={i} onOpen={() => { setDetail(m); if (!m.read) void setRead(m, true); }} />
                      ))}
                    </AnimatePresence>
                  </ul>
                )}
                <p className="mail-hint">左右にスワイプで 既読 ⇄ 未読。Flick の中だけで変わり、{slot === "univ" ? "Outlook" : "Gmail"} の既読は変えません。</p>
              </>
            )}
            {src && (
              <button
                className="mail-disconnect"
                data-testid="mail-disconnect"
                onClick={async () => {
                  if (!window.confirm(`${SLOT_LABEL[slot]}（${src.email}）との接続を解除しますか？`)) return;
                  await disconnectSlot(slot);
                  toast("接続を解除しました");
                }}
              >
                {SLOT_LABEL[slot]}：{src.email} の接続を解除
              </button>
            )}
          </div>

          <MailDetail item={detail} onClose={() => setDetail(null)} toast={toast} />
        </motion.section>
      )}
    </AnimatePresence>
  );
}

const CONNECT: Record<Slot, { title: string; body: string; button: string }> = {
  personal: { title: "個人のGmailをつなぐ", body: "ふだん使っているGmailのアカウントを選んでください。", button: "個人のGmailをつなぐ" },
  business: { title: "事業（AIHP）のGmailをつなぐ", body: "Googleの画面で、AIHPで使っているアカウントを選んでください。", button: "事業のGmailをつなぐ" },
  univ: { title: "大学のOutlookをつなぐ", body: "Microsoftの画面で、大学のアカウントでログインしてください。転送はしません。", button: "大学のOutlookをつなぐ" },
};

function ConnectCard({ slot, ready }: { slot: Slot; ready: boolean }) {
  const t = CONNECT[slot];
  return (
    <div className="mail-connect" data-testid={`mail-connect-card-${slot}`}>
      <motion.div className={`mail-hero-icon src-${slot}`} initial={{ scale: 0.6, rotate: -8 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 300, damping: 16 }}>
        <MailIcon size={34} />
      </motion.div>
      <h3>{t.title}</h3>
      <p>{t.body}</p>
      <p className="sub">毎日 10:00 と 20:00 に、受信箱の新しいメールを読み込みます。読むだけで、送信・削除・既読の変更はしません。</p>
      {ready ? (
        <motion.button className="primary-btn" whileTap={{ scale: 0.96 }} onClick={() => connectSlot(slot)} data-testid="mail-connect">
          {t.button}
        </motion.button>
      ) : (
        <div className="mail-notready" data-testid="mail-notready">
          大学のOutlookを読むには、先にMicrosoft側の準備（アプリ登録）が必要です。準備ができると、ここに「つなぐ」ボタンが出ます。
        </div>
      )}
    </div>
  );
}

function ExpiredCard({ slot }: { slot: Slot }) {
  return (
    <div className="mail-expired" data-testid="mail-expired">
      <h3>{SLOT_LABEL[slot]}との接続が切れました</h3>
      <p>{slot === "univ" ? "大学のアカウントで、もう一度ログインしてください。" : "Googleのアプリが「テスト中」のあいだは、7日ごとにつなぎ直しが必要です。"}</p>
      <motion.button className="primary-btn" whileTap={{ scale: 0.96 }} onClick={() => connectSlot(slot)} data-testid="mail-reconnect">
        つなぎ直す
      </motion.button>
    </div>
  );
}

/** 1通。左右にスワイプで既読・未読、タップで中身 */
function MailRow({ m, i, onOpen }: { m: MailItem; i: number; onOpen: () => void }) {
  const x = useMotionValue(0);
  const bgOpacity = useTransform(x, [-SWIPE, -20, 0, 20, SWIPE], [1, 0.4, 0, 0.4, 1]);
  const [armed, setArmed] = useState(false);
  const dragged = useRef(false); // スワイプした直後のタップ扱いを防ぐ
  return (
    <motion.li
      className="mail-li"
      data-testid="mail-row"
      data-read={m.read ? "1" : "0"}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ delay: Math.min(i, 10) * 0.025 }}
    >
      <motion.div className={`mail-swipe-bg ${m.read ? "to-unread" : "to-read"} ${armed ? "armed" : ""}`} style={{ opacity: bgOpacity }} aria-hidden="true">
        <span>{m.read ? "未読にする" : "既読にする"}</span>
        <span>{m.read ? "未読にする" : "既読にする"}</span>
      </motion.div>
      <motion.button
        className={`mail-row ${m.read ? "" : "unread"}`}
        style={{ x, touchAction: "pan-y" }}
        drag="x"
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.55}
        dragDirectionLock
        onDragStart={() => { dragged.current = true; }}
        onDrag={(_, info) => {
          const a = Math.abs(info.offset.x) > SWIPE;
          if (a !== armed) { setArmed(a); if (a) haptic("light"); }
        }}
        onDragEnd={(_, info) => {
          setArmed(false);
          if (Math.abs(info.offset.x) > SWIPE || Math.abs(info.velocity.x) > 700) { haptic(); void setRead(m, !m.read); }
          setTimeout(() => { dragged.current = false; }, 0);
        }}
        onClick={() => { if (!dragged.current) { haptic("light"); onOpen(); } }}
      >
        <i className="unread-dot" aria-label={m.read ? "既読" : "未読"} />
        <div className="mail-row-body">
          <div className="mail-row-top">
            <span className="mail-from">{m.from_name}</span>
            <span className="mail-time">{listTime(m.date)}</span>
          </div>
          <div className="mail-subject">{m.subject}</div>
          <div className="mail-summary">{m.summary || m.snippet}</div>
          {m.task_title && <span className="mail-task-chip"><Sparkle size={11} /> やることあり</span>}
        </div>
      </motion.button>
    </motion.li>
  );
}

/** アプリの中で中身を見る（外のサイトへ飛ばない） */
function MailDetail({ item, onClose, toast }: { item: MailItem | null; onClose: () => void; toast: (t: string) => void }) {
  const live = useMail((s) => (item ? s.items.find((m) => m.slot === item.slot && m.id === item.id) ?? item : null));
  const drag = useDragControls();
  const [added, setAdded] = useState(false);
  useEffect(() => setAdded(false), [item?.id]);
  const m = live;
  const title = m ? m.task_title ?? m.subject : "";
  const odd = m?.task_title ? strangeKanji(m.task_title, `${m.from_name} ${m.subject} ${m.snippet} ${m.summary}`) : [];

  // メール画面は横から動く（transform がある）ので、その中に置くと位置がずれる。body の直下に出す
  return createPortal(
    <AnimatePresence>
      {m && (
        <>
          <motion.div key="scrim" className="scrim mail-detail-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.section
            key="sheet"
            className="sheet glass mail-detail"
            role="dialog"
            aria-label="メールの中身"
            data-testid="mail-detail"
            drag="y"
            dragControls={drag}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0.04, bottom: 0.7 }}
            onDragEnd={(_, i) => (i.offset.y > 110 || i.velocity.y > 650) && onClose()}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "105%" }}
            transition={{ type: "spring", stiffness: 380, damping: 36 }}
          >
            <div className="grabber-zone" onPointerDown={(e) => drag.start(e)}><div className="grabber" /></div>
            <div className="mail-detail-from">
              <strong>{m.from_name}</strong>
              <span>{m.from_addr}</span>
              <span>{fullTime(m.date)}</span>
            </div>
            <h3 className="mail-detail-subject">{m.subject}</h3>
            {m.summary && (
              <div className="mail-detail-box ai" data-testid="mail-detail-summary">
                <div className="mail-detail-label"><Sparkle size={13} /> AIの説明</div>
                <p>{m.summary}</p>
              </div>
            )}
            <div className="mail-detail-box" data-testid="mail-detail-snippet">
              <div className="mail-detail-label">メールの冒頭</div>
              <p>{m.snippet || "（本文なし）"}</p>
            </div>
            <div className="mail-detail-task">
              <div className="mail-detail-label">タスクにするなら</div>
              <div className="mail-task-title">{title}</div>
              <div className="plan-meta">
                {m.task_due && <span className="plan-due">{dueLabel(m.task_due).text}</span>}
                {odd.length > 0 && <span className="plan-warn">字を確認：{odd.join("")}</span>}
              </div>
            </div>
            <div className="sheet-actions">
              <motion.button
                className="ghost-btn"
                whileTap={{ scale: 0.96 }}
                data-testid="mail-toggle-read"
                onClick={() => { haptic(); void setRead(m, !m.read); if (m.read) onClose(); }}
              >
                {m.read ? "未読に戻す" : "既読にする"}
              </motion.button>
              <motion.button
                className="primary-btn"
                disabled={added}
                whileTap={{ scale: 0.96 }}
                data-testid="mail-to-task"
                onClick={() => {
                  addPlanned([{ title, due_date: m.task_due, status: "todo", note: `✉ ${m.from_name}「${m.subject}」` }]);
                  haptic("success");
                  setAdded(true);
                  toast("未着手に追加しました");
                }}
              >
                {added ? <><Check size={16} /> 追加しました</> : "タスクにする"}
              </motion.button>
            </div>
            <a className="mail-open-original" href={m.link} target="_blank" rel="noreferrer" data-testid="mail-open-original">
              {m.slot === "univ" ? "Outlook" : "Gmail"}で全文を開く
            </a>
          </motion.section>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
