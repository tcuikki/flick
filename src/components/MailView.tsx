import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useDragControls, useMotionValue, useTransform } from "motion/react";
import {
  type MailItem, type Slot, SLOTS, SLOT_LABEL,
  connectSlot, disconnectSlot, fetchBody, fullTime, listTime, markOpened,
  readAll, searchMail, setRead, useMail,
} from "../mail";
import { addPlanned } from "../store";
import { haptic } from "../haptics";
import { Check, MailIcon } from "./Icons";

type Props = { active: boolean; toast: (text: string) => void };

const SWIPE = 80;

/** メールのページ（下のタブ「メール」）。個人・事業・大学の受信箱を新着順に、未読・既読つきで見せる */
export function MailView({ active, toast }: Props) {
  const sources = useMail((s) => s.sources);
  const items = useMail((s) => s.items);
  const [slot, setSlot] = useState<Slot>("personal");
  const [detail, setDetail] = useState<MailItem | null>(null);
  const detailRef = useRef<MailItem | null>(null);
  detailRef.current = detail;

  // 検索
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState<{ slot: Slot; q: string; items: MailItem[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");

  useEffect(() => {
    if (!active) return;
    // 未読があるところを最初に開く
    const first = SLOTS.find((s) => items.some((m) => m.slot === s && !m.read)) ?? SLOTS.find((s) => sources.some((x) => x.slot === s)) ?? "personal";
    setSlot(first);
    setQuery("");
    setSearched(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && detailRef.current && setDetail(null);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      setDetail(null);
      markOpened(); // ほかのページへ移ったら「見た」ことにして、今日のお知らせを消す
    };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const runSearch = async (s: Slot, q: string) => {
    const word = q.trim();
    if (!word) { setSearched(null); return; }
    setSearching(true);
    setSearchError("");
    try {
      setSearched({ slot: s, q: word, items: await searchMail(s, word) });
    } catch {
      setSearchError("検索できませんでした");
      setSearched({ slot: s, q: word, items: [] });
    } finally {
      setSearching(false);
    }
  };

  // 検索中に枠を変えたら、その枠で同じ言葉を探し直す
  useEffect(() => {
    if (active && searched && searched.slot !== slot) void runSearch(slot, searched.q);
  }, [slot]); // eslint-disable-line react-hooks/exhaustive-deps

  const src = sources.find((s) => s.slot === slot) ?? null;
  const list = items.filter((m) => m.slot === slot).sort((a, b) => b.date - a.date);
  const unread = (s: Slot) => items.filter((m) => m.slot === s && !m.read).length;
  const inSearch = Boolean(searched && searched.slot === slot);
  const openItem = (m: MailItem) => {
    setDetail(m);
    if (!m.read && items.some((x) => x.slot === m.slot && x.id === m.id)) void setRead(m, true);
  };

  return (
    <section className="mail-view" aria-label="メール" data-testid="mail-view">
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

            {!src && <ConnectCard slot={slot} />}
            {src?.status === "expired" && <ExpiredCard slot={slot} />}
            {src?.status === "ok" && (
              <>
                <form
                  className="mail-search"
                  role="search"
                  onSubmit={(e) => { e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur(); void runSearch(slot, query); }}
                >
                  <SearchIcon />
                  <input
                    type="search"
                    value={query}
                    placeholder={`${SLOT_LABEL[slot]}のメールを検索（古いメールも）`}
                    aria-label="メールを検索"
                    enterKeyHint="search"
                    data-testid="mail-search"
                    onChange={(e) => { setQuery(e.target.value); if (!e.target.value) setSearched(null); }}
                  />
                  {query && (
                    <button type="button" className="mail-search-clear" aria-label="検索をやめる" data-testid="mail-search-clear" onClick={() => { setQuery(""); setSearched(null); }}>
                      ×
                    </button>
                  )}
                </form>

                {inSearch ? (
                  <>
                    <div className="mail-count search" data-testid="mail-search-count">
                      <b>「{searched!.q}」</b>
                      <span>{searching ? "探しています…" : searchError || `${searched!.items.length}件（新しい順・最大20件）`}</span>
                    </div>
                    {!searching && searched!.items.length === 0 && !searchError && <div className="mail-empty">見つかりませんでした</div>}
                    <ul className="mail-list" data-testid="mail-search-results">
                      {searched!.items.map((m, i) => (
                        <MailRow key={m.id} m={m} i={i} swipe={false} onOpen={() => openItem(m)} />
                      ))}
                    </ul>
                  </>
                ) : (
                  <>
                    <div className="mail-count" data-testid="mail-count">
                      <b>未読 {unread(slot)}件</b>
                      {unread(slot) > 0 ? (
                        <button
                          className="mail-readall"
                          data-testid="mail-read-all"
                          onClick={() => { haptic("success"); void readAll(slot); toast(`${SLOT_LABEL[slot]}をすべて既読にしました`); }}
                        >
                          すべて既読にする
                        </button>
                      ) : (
                        <span>受信箱の新しい{list.length}件</span>
                      )}
                    </div>
                    {list.length === 0 && <div className="mail-empty" data-testid="mail-none">受信箱にメールはまだありません。届くと自動でここに出ます。</div>}
                    {list.length > 0 && (
                      <ul className="mail-list" data-testid="mail-list">
                        <AnimatePresence initial={false}>
                          {list.map((m, i) => (
                            <MailRow key={m.id} m={m} i={i} swipe onOpen={() => openItem(m)} />
                          ))}
                        </AnimatePresence>
                      </ul>
                    )}
                    <p className="mail-hint">左右にスワイプで 既読 ⇄ 未読。Flick の中だけで変わり、Gmail の既読は変えません。</p>
                  </>
                )}
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
    </section>
  );
}

const SearchIcon = () => (
  <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true" className="mail-search-icon">
    <circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" />
  </svg>
);

const CONNECT: Record<Slot, { title: string; body: string; button: string }> = {
  personal: { title: "個人のGmailをつなぐ", body: "ふだん使っているGmailのアカウントを選んでください。", button: "個人のGmailをつなぐ" },
  business: { title: "事業（AIHP）のGmailをつなぐ", body: "Googleの画面で、AIHPで使っているアカウントを選んでください。", button: "事業のGmailをつなぐ" },
  univ: {
    title: "大学の受け皿のGmailをつなぐ",
    body: "大学のOutlookから転送している「受け皿」のGmailを選んでください。ふだんのGmailには大学のメールは入りません。",
    button: "受け皿のGmailをつなぐ",
  },
};

function ConnectCard({ slot }: { slot: Slot }) {
  const t = CONNECT[slot];
  return (
    <div className="mail-connect" data-testid={`mail-connect-card-${slot}`}>
      <motion.div className={`mail-hero-icon src-${slot}`} initial={{ scale: 0.6, rotate: -8 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 300, damping: 16 }}>
        <MailIcon size={34} />
      </motion.div>
      <h3>{t.title}</h3>
      <p>{t.body}</p>
      <p className="sub">届いたメールは自動で読み込みます。読むだけで、送信・削除・既読の変更はしません。</p>
      <motion.button className="primary-btn" whileTap={{ scale: 0.96 }} onClick={() => connectSlot(slot)} data-testid="mail-connect">
        {t.button}
      </motion.button>
    </div>
  );
}

function ExpiredCard({ slot }: { slot: Slot }) {
  return (
    <div className="mail-expired" data-testid="mail-expired">
      <h3>{SLOT_LABEL[slot]}との接続が切れました</h3>
      <p>Googleのアプリが「テスト中」のあいだは、7日ごとにつなぎ直しが必要です。</p>
      <motion.button className="primary-btn" whileTap={{ scale: 0.96 }} onClick={() => connectSlot(slot)} data-testid="mail-reconnect">
        つなぎ直す
      </motion.button>
    </div>
  );
}

/** 1通。左右にスワイプで既読・未読、タップで中身 */
function MailRow({ m, i, swipe, onOpen }: { m: MailItem; i: number; swipe: boolean; onOpen: () => void }) {
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
      {swipe && (
        <motion.div className={`mail-swipe-bg ${m.read ? "to-unread" : "to-read"} ${armed ? "armed" : ""}`} style={{ opacity: bgOpacity }} aria-hidden="true">
          <span>{m.read ? "未読にする" : "既読にする"}</span>
          <span>{m.read ? "未読にする" : "既読にする"}</span>
        </motion.div>
      )}
      <motion.button
        className={`mail-row ${m.read ? "" : "unread"}`}
        style={{ x, touchAction: "pan-y" }}
        drag={swipe ? "x" : false}
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
          <div className="mail-summary">{m.snippet}</div>
        </div>
      </motion.button>
    </motion.li>
  );
}

/** 本文の中の URL を押せるようにする */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"'）」]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? <a key={i} href={p} target="_blank" rel="noreferrer">{p}</a> : <span key={i}>{p}</span>,
      )}
    </>
  );
}

/** アプリの中で本文の全文を読む（外のサイトへ飛ばない） */
function MailDetail({ item, onClose, toast }: { item: MailItem | null; onClose: () => void; toast: (t: string) => void }) {
  const live = useMail((s) => (item ? s.items.find((m) => m.slot === item.slot && m.id === item.id) ?? null : null));
  const m = live ?? item;
  const inList = Boolean(live);
  const drag = useDragControls();
  const [added, setAdded] = useState(false);
  const [body, setBody] = useState<{ id: string; text: string | null; error?: boolean } | null>(null);

  useEffect(() => {
    setAdded(false);
    if (!item) return;
    let alive = true;
    setBody(null);
    fetchBody(item)
      .then((text) => alive && setBody({ id: item.id, text }))
      .catch(() => alive && setBody({ id: item.id, text: null, error: true }));
    return () => { alive = false; };
  }, [item?.slot, item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loaded = body && m && body.id === m.id;

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

            <div className="mail-detail-body" data-testid="mail-detail-body">
              {!loaded && (
                <div className="mail-body-loading" aria-label="本文を読み込んでいます">
                  <div className="sk" style={{ width: "92%" }} /><div className="sk" style={{ width: "80%" }} /><div className="sk" style={{ width: "86%" }} /><div className="sk" style={{ width: "54%" }} />
                </div>
              )}
              {loaded && body!.text && <p><Linkified text={body!.text} /></p>}
              {loaded && !body!.text && (
                <p className="mail-body-missing">{body!.error ? "本文を読み込めませんでした。" : "本文がありません（画像や添付ファイルだけのメールかもしれません）。"}下の「Gmailで開く」から確認してください。</p>
              )}
            </div>

            <div className="sheet-actions">
              {inList && (
                <motion.button
                  className="ghost-btn"
                  whileTap={{ scale: 0.96 }}
                  data-testid="mail-toggle-read"
                  onClick={() => { haptic(); void setRead(m, !m.read); if (m.read) onClose(); }}
                >
                  {m.read ? "未読に戻す" : "既読にする"}
                </motion.button>
              )}
              <motion.button
                className="primary-btn"
                disabled={added}
                whileTap={{ scale: 0.96 }}
                data-testid="mail-to-task"
                onClick={() => {
                  addPlanned([{ title: m.subject, due_date: null, status: "todo", note: `✉ ${m.from_name}「${m.subject}」` }]);
                  haptic("success");
                  setAdded(true);
                  toast("未着手に追加しました");
                }}
              >
                {added ? <><Check size={16} /> 追加しました</> : "タスクにする"}
              </motion.button>
            </div>
            <a className="mail-open-original" href={m.link} target="_blank" rel="noreferrer" data-testid="mail-open-original">
              Gmailで開く
            </a>
          </motion.section>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
