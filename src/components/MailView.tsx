import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  type Digest, type MailItem, type MailKind, type MailSource, SOURCE_LABEL,
  checkMailNow, connectMail, digestLabel, disconnectMail, gmailLink, markSeen, nextCheckLabel, timeLabel, useMail,
} from "../mail";
import { addPlanned } from "../store";
import { dueLabel } from "../date";
import { haptic } from "../haptics";
import { strangeKanji } from "../kanji";
import { ChevronLeft, ChevronRight, MailIcon, Refresh, Sparkle } from "./Icons";

type Props = { open: boolean; onClose: () => void; toast: (text: string) => void };
type Source = MailSource;

const KIND_LABEL: Record<MailKind, string> = { action: "要対応", check: "確認", info: "お知らせ", ad: "広告・SNS" };
const KIND_ORDER: MailKind[] = ["action", "check", "info", "ad"];

export const countBy = (d: Digest) => ({
  gmail: d.items.filter((m) => m.source === "gmail").length,
  univ: d.items.filter((m) => m.source === "univ").length,
  icloud: d.items.filter((m) => m.source === "icloud").length,
  action: d.items.filter((m) => m.kind === "action").length,
});

/** 表示する枠：Gmail と大学はいつも、iCloud は届いたときだけ */
export const sourcesOf = (d: Digest): Source[] => (countBy(d).icloud > 0 ? ["gmail", "univ", "icloud"] : ["gmail", "univ"]);

/** お知らせ用の短い件数（例「Gmail 8・大学 3」） */
export const sourceSummary = (d: Digest) => {
  const c = countBy(d);
  return sourcesOf(d).map((s) => `${SOURCE_LABEL[s]} ${c[s]}`).join("・");
};

/** メールの枠（未着手・進行中・完了とは別）。10:00 / 18:00 のまとめを Gmail / iCloud に分けて見せる */
export function MailView({ open, onClose, toast }: Props) {
  const account = useMail((s) => s.account);
  const digests = useMail((s) => s.digests);
  const checking = useMail((s) => s.checking);
  const [sel, setSel] = useState<string | null>(null);
  const [source, setSource] = useState<Source>("gmail");

  const digest = digests.find((d) => d.id === sel) ?? digests[0] ?? null;

  useEffect(() => {
    if (!open) return;
    setSel(null);
    document.documentElement.classList.add("mail-open");
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      document.documentElement.classList.remove("mail-open");
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  // 開いている間に表示したまとめは既読にする（一覧のお知らせが消える）
  useEffect(() => {
    if (open && digest && !digest.seen_at) void markSeen(digest.id);
  }, [open, digest]);

  // 要対応があるところ → 届いているところ の順で最初に見せる
  useEffect(() => {
    if (!digest) return;
    const list = sourcesOf(digest);
    const has = (s: Source, k?: MailKind) => digest.items.some((m) => m.source === s && (!k || m.kind === k));
    setSource(list.find((s) => has(s, "action")) ?? list.find((s) => has(s)) ?? "gmail");
  }, [digest?.id]);

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
              <span>{account?.status === "ok" ? `次の自動チェック ${nextCheckLabel()}` : "Gmail・iCloud"}</span>
            </div>
            {account?.status === "ok" && (
              <motion.button
                className={`mail-refresh ${checking ? "spin" : ""}`}
                whileTap={{ scale: 0.88 }}
                disabled={checking}
                aria-label="今すぐチェック"
                data-testid="mail-check"
                onClick={async () => { haptic("light"); toast(await checkMailNow()); setSel(null); }}
              >
                <Refresh size={19} />
              </motion.button>
            )}
          </header>

          <div className="mail-body">
            {!account && <Connect />}
            {account?.status === "expired" && <Expired />}
            {account?.status === "ok" && !digest && (
              <div className="mail-empty" data-testid="mail-nodigest">
                <p>まだチェックしていません。</p>
                <p className="sub">右上の ↻ を押すと、今すぐ24時間分のメールをまとめます。</p>
              </div>
            )}
            {account && digest && (
              <DigestView key={digest.id} digest={digest} digests={digests} onPick={setSel} source={source} setSource={setSource} email={account.email} toast={toast} />
            )}
            {account && (
              <button
                className="mail-disconnect"
                data-testid="mail-disconnect"
                onClick={async () => {
                  if (!window.confirm("Gmailとの接続を解除しますか？（まとめも消えます）")) return;
                  await disconnectMail();
                  toast("接続を解除しました");
                }}
              >
                Gmailとの接続を解除（{account.email}）
              </button>
            )}
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}

function Connect() {
  return (
    <div className="mail-connect" data-testid="mail-connect-card">
      <motion.div className="mail-hero-icon" initial={{ scale: 0.6, rotate: -8 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 300, damping: 16 }}>
        <MailIcon size={38} />
      </motion.div>
      <h3>毎日 10:00 と 18:00 に、届いたメールをまとめます</h3>
      <p>Gmail・大学・iCloud に分けて、AI が「何のメールか」と「やること」を出します。メールは読むだけで、送信や削除はしません。</p>
      <motion.button className="primary-btn" whileTap={{ scale: 0.96 }} onClick={connectMail} data-testid="mail-connect">
        Gmailをつなぐ
      </motion.button>
      <div className="mail-howto">
        <strong>大学（Outlook）のメールも見るには</strong>
        <ol>
          <li>outlook.office.com に大学のアカウントでログインする</li>
          <li>設定（歯車）→「メール」→「転送」で「転送を有効にする」をオンにし、このGmailのアドレスを入れる</li>
          <li>「転送されたメッセージのコピーを保持する」にチェックを入れて保存する</li>
        </ol>
      </div>
      <div className="mail-howto">
        <strong>iCloud のメールも見るには</strong>
        <ol>
          <li>パソコンで iCloud.com を開き、「メール」を開く</li>
          <li>設定（歯車）→「転送」で、このGmailのアドレスへの転送をオンにする</li>
          <li>転送されたメールは、宛先を見て自動で「大学」「iCloud」に分けて表示します</li>
        </ol>
      </div>
    </div>
  );
}

function Expired() {
  return (
    <div className="mail-expired" data-testid="mail-expired">
      <h3>Gmailとの接続が切れました</h3>
      <p>Google のアプリが「テスト中」のあいだは、7日ごとにつなぎ直しが必要です。</p>
      <motion.button className="primary-btn" whileTap={{ scale: 0.96 }} onClick={connectMail} data-testid="mail-reconnect">
        つなぎ直す
      </motion.button>
    </div>
  );
}

type DigestProps = {
  digest: Digest; digests: Digest[]; onPick: (id: string) => void;
  source: Source; setSource: (s: Source) => void; email: string; toast: (t: string) => void;
};

function DigestView({ digest, digests, onPick, source, setSource, email, toast }: DigestProps) {
  const c = countBy(digest);
  const items = digest.items.filter((m) => m.source === source);
  const ids = new Set(items.map((m) => m.id));
  const tasks = digest.tasks.filter((t) => ids.has(t.mailId));
  const sourceText = useMemo(() => digest.items.map((m) => `${m.fromName} ${m.subject} ${m.summary} ${m.snippet ?? ""}`).join(" "), [digest]);
  const [picked, setPicked] = useState<Set<number>>(() => new Set(tasks.map((_, i) => i)));
  const [added, setAdded] = useState(false);
  const [showAds, setShowAds] = useState(false);
  useEffect(() => { setPicked(new Set(tasks.map((_, i) => i))); setAdded(false); }, [source]);

  const groups = KIND_ORDER.map((k) => ({ kind: k, list: items.filter((m) => m.kind === k) })).filter((g) => g.list.length);

  return (
    <>
      {digests.length > 1 && (
        <div className="digest-chips" role="tablist" aria-label="チェックした時間">
          {digests.map((d) => (
            <button key={d.id} role="tab" aria-selected={d.id === digest.id} className={`chip ${d.id === digest.id ? "on" : ""}`} onClick={() => { haptic(); onPick(d.id); }}>
              {digestLabel(d.created_at)}
              {!d.seen_at && <i className="chip-dot" />}
            </button>
          ))}
        </div>
      )}

      <motion.div className="digest-hero" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} data-testid="digest-hero">
        <div className="digest-when">{digestLabel(digest.created_at)} のメール</div>
        <div className="digest-count">
          <b>{digest.items.length}</b>件
          {c.action > 0 && <span className="pill-action">要対応 {c.action}</span>}
        </div>
        {digest.total > digest.items.length && <div className="digest-more">ほか {digest.total - digest.items.length} 件は Gmail で確認してください</div>}
      </motion.div>

      <div className={`seg ${sourcesOf(digest).length === 3 ? "" : "seg-2"} mail-seg`} role="tablist" aria-label="メールの種類">
        {sourcesOf(digest).map((s) => (
          <button key={s} role="tab" aria-selected={source === s} className={`seg-btn ${source === s ? "on" : ""}`} data-testid={`mail-tab-${s}`} onClick={() => { haptic(); setSource(s); }}>
            {source === s && <motion.span layoutId="mail-seg-pill" className={`seg-pill src-${s}`} transition={{ type: "spring", stiffness: 520, damping: 34 }} />}
            <span>{SOURCE_LABEL[s]} {c[s]}</span>
          </button>
        ))}
      </div>

      {tasks.length > 0 && (
        <motion.div className="mail-tasks" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} data-testid="mail-tasks">
          <div className="mail-tasks-head"><Sparkle size={15} /> やることの案</div>
          <ul>
            {tasks.map((t, i) => {
              const odd = strangeKanji(t.title, sourceText);
              return (
                <li key={i} className={picked.has(i) && !added ? "" : "off"}>
                  <input
                    type="checkbox"
                    className="plan-check"
                    checked={picked.has(i)}
                    disabled={added}
                    aria-label="このタスクを追加する"
                    onChange={(e) => setPicked((p) => { const n = new Set(p); e.target.checked ? n.add(i) : n.delete(i); return n; })}
                  />
                  <div className="plan-body">
                    <div className="mail-task-title">{t.title}</div>
                    <div className="plan-meta">
                      {t.due_date && <span className="plan-due">{dueLabel(t.due_date).text}</span>}
                      {odd.length > 0 && <span className="plan-warn">字を確認：{odd.join("")}</span>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <motion.button
            className="primary-btn"
            disabled={added || picked.size === 0}
            whileTap={{ scale: 0.96 }}
            data-testid="mail-add-tasks"
            onClick={() => {
              const chosen = tasks.filter((_, i) => picked.has(i)).map(({ mailId, ...t }) => t);
              addPlanned(chosen);
              haptic("success");
              setAdded(true);
              toast(`${chosen.length}件を未着手に追加しました`);
            }}
          >
            {added ? "追加しました" : `${picked.size}件をタスクに追加`}
          </motion.button>
        </motion.div>
      )}

      {items.length === 0 && <div className="mail-empty" data-testid="mail-none">この時間に届いた{SOURCE_LABEL[source]}のメールはありません</div>}

      {groups.map((g) => (
        <section key={g.kind} className="mail-group" data-testid={`mail-group-${g.kind}`}>
          {g.kind === "ad" ? (
            <button className="mail-group-head as-btn" onClick={() => setShowAds((v) => !v)} data-testid="mail-ads-toggle">
              <i className={`kind-dot k-${g.kind}`} />{KIND_LABEL[g.kind]} {g.list.length}件
              <ChevronRight size={14} className={`ads-chev ${showAds ? "open" : ""}`} />
            </button>
          ) : (
            <div className="mail-group-head"><i className={`kind-dot k-${g.kind}`} />{KIND_LABEL[g.kind]} {g.list.length}件</div>
          )}
          <AnimatePresence initial={false}>
            {(g.kind !== "ad" || showAds) && (
              <motion.ul
                className="mail-list"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ type: "spring", stiffness: 380, damping: 36 }}
              >
                {g.list.map((m, i) => <MailRow key={m.id} m={m} i={i} email={email} />)}
              </motion.ul>
            )}
          </AnimatePresence>
        </section>
      ))}
    </>
  );
}

function MailRow({ m, i, email }: { m: MailItem; i: number; email: string }) {
  return (
    <motion.li initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 8) * 0.03 }}>
      <a className={`mail-row ${m.unread ? "unread" : ""}`} href={gmailLink(m.threadId, email)} target="_blank" rel="noreferrer" data-testid="mail-row">
        <div className="mail-row-top">
          <span className="mail-from">{m.fromName}</span>
          <span className="mail-time">{timeLabel(m.date)}</span>
        </div>
        <div className="mail-subject">{m.subject}</div>
        <div className="mail-summary">{m.summary}</div>
      </a>
    </motion.li>
  );
}
