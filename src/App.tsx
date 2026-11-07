import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, MotionConfig, motion, useScroll, useTransform } from "motion/react";
import {
  STATUS_LABEL, type Status, type Task,
  deleteTask, drainBootQueue, login, logout, restoreTask, setAiEnabled, setStatus, useStore,
} from "./store";
import { headerDate } from "./date";
import { haptic } from "./haptics";
import { TaskCard } from "./components/TaskCard";
import { TaskSheet } from "./components/TaskSheet";
import { Tabs } from "./components/Tabs";
import { NewTaskSheet } from "./components/NewTaskSheet";
import { AiSheet } from "./components/AiSheet";
import { MailView, countBy } from "./components/MailView";
import { digestLabel, loadMail, useMail } from "./mail";
import { primeKeyboard } from "./focus";
import { ChevronRight, Google, MailIcon, Mic, Plus, Sparkle, Tray, Wifi } from "./components/Icons";

type Toast = { id: number; text: string; undo?: () => void };
const MIN_SKELETON_MS = 450;
const DIR: Record<Status, number> = { todo: 0, doing: 1, done: 2 };

export function App() {
  const tasks = useStore((s) => s.tasks);
  const auth = useStore((s) => s.auth);
  const user = useStore((s) => s.user);
  const ready = useStore((s) => s.ready);
  const online = useStore((s) => s.online);
  const aiOn = useStore((s) => s.settings.ai);

  const [tab, setTabState] = useState<Status>("todo");
  const [dir, setDir] = useState(0);
  const [booted, setBooted] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [menu, setMenu] = useState(false);
  const [adding, setAdding] = useState(false);
  const [asking, setAsking] = useState(false);
  const [mailOpen, setMailOpen] = useState(false);
  const mailAccount = useMail((m) => m.account);
  const latest = useMail((m) => m.digests[0] ?? null);
  const unseen = useMail((m) => m.digests.filter((d) => !d.seen_at && d.items.length > 0).length);
  const closeMail = useCallback(() => setMailOpen(false), []);

  const setTab = useCallback((s: Status) => {
    setTabState((cur) => {
      setDir(Math.sign(DIR[s] - DIR[cur]));
      return s;
    });
  }, []);

  const showToast = useCallback((text: string, undo?: () => void) => {
    const id = Date.now();
    setToast({ id, text, undo });
    setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 4500);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("signed-out", auth === "out");
  }, [auth]);

  /* ---------- スケルトン → 本体 ---------- */
  useEffect(() => {
    if (!ready || booted) return;
    const wait = Math.max(0, MIN_SKELETON_MS - performance.now());
    const t = setTimeout(() => {
      const boot = document.getElementById("boot");
      boot?.classList.add("hide");
      setTimeout(() => boot?.remove(), 500);
      setBooted(true);
    }, wait);
    return () => clearTimeout(t);
  }, [ready, booted]);

  /* ---------- 追加（＋ボタン / AI） ---------- */
  const openAdd = useCallback(() => {
    primeKeyboard();
    haptic("light");
    setAdding(true);
  }, []);
  const closeAdd = useCallback(() => setAdding(false), []);
  const closeAsk = useCallback(() => setAsking(false), []);

  const onAdded = useCallback(
    (s: Status) => {
      setAdding(false);
      setTab(s);
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [setTab],
  );
  const onAiAdded = useCallback(
    (n: number) => {
      setAsking(false);
      setTab("todo");
      window.scrollTo({ top: 0, behavior: "smooth" });
      showToast(`${n}件追加しました`);
    },
    [setTab, showToast],
  );

  /* ---------- メール（10:00 / 18:00 のまとめ） ---------- */
  useEffect(() => {
    if (auth !== "in") return;
    void loadMail();
    const onVis = () => document.visibilityState === "visible" && void loadMail();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [auth]);

  useEffect(() => {
    drainBootQueue();
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if ((e.key === "/" || e.key === "n") && !(el && /INPUT|TEXTAREA/.test(el.tagName)) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setAdding(true);
      }
    };
    window.addEventListener("keydown", onKey);
    const params = new URLSearchParams(location.search);
    if (params.get("login") === "failed") {
      showToast("ログインできませんでした");
      history.replaceState(null, "", "/");
    }
    const mail = params.get("mail");
    if (mail) {
      showToast(mail === "connected" ? "Gmailをつなぎました" : mail === "denied" ? "メールを読む許可がありませんでした" : "Gmailにつなげませんでした");
      if (mail === "connected") setMailOpen(true);
      history.replaceState(null, "", "/");
    }
    return () => window.removeEventListener("keydown", onKey);
  }, [showToast]);

  /* ---------- 一覧 ---------- */
  const counts = useMemo(() => {
    const c: Record<Status, number> = { todo: 0, doing: 0, done: 0 };
    tasks.forEach((t) => c[t.status]++);
    return c;
  }, [tasks]);

  const list = useMemo(() => {
    const l = auth === "out" ? tasks.slice() : tasks.filter((t) => t.status === tab);
    // 未着手は作成が新しい順、進行中/完了は動かした順
    return l.sort((a, b) => (tab === "todo" ? b.sort - a.sort : b.updated_at - a.updated_at));
  }, [tasks, tab, auth]);

  const handleDelete = useCallback(
    (t: Task) => {
      const removed = deleteTask(t.id);
      setOpenId(null);
      if (removed) showToast("削除しました", () => { restoreTask(removed); haptic(); });
    },
    [showToast],
  );

  const onAction = useCallback(
    (t: Task, a: { kind: "status"; to: Status } | { kind: "delete" }) => {
      if (a.kind === "delete") handleDelete(t);
      else {
        setStatus(t.id, a.to);
        if (a.to === "done") haptic("success");
      }
    },
    [handleDelete],
  );

  const onToggleDone = useCallback((t: Task) => {
    const to: Status = t.status === "done" ? "todo" : "done";
    haptic(to === "done" ? "success" : "light");
    // チェックの描画を見せてから一覧から抜く
    setTimeout(() => setStatus(t.id, to), 380);
  }, []);

  const onComplete = useCallback((t: Task) => {
    const to: Status = t.status === "done" ? "todo" : "done";
    haptic(to === "done" ? "success" : "light");
    setOpenId(null);
    setStatus(t.id, to);
    showToast(to === "done" ? "完了にしました" : "未着手に戻しました");
  }, [showToast]);

  /* ---------- ヘッダーのスクロール演出（大きなタイトル → 縮小 + スクロールエッジ） ---------- */
  const { scrollY } = useScroll();
  const titleScale = useTransform(scrollY, [0, 80], [1, 0.62]);
  const titleY = useTransform(scrollY, [0, 80], [0, 34]);
  const dateOpacity = useTransform(scrollY, [0, 40], [1, 0]);
  const edgeOpacity = useTransform(scrollY, [10, 60], [0, 1]);

  return (
    <MotionConfig reducedMotion="user">
      <motion.div className="scroll-edge top" style={{ opacity: edgeOpacity }} aria-hidden="true" />
      <div className="scroll-edge bottom" aria-hidden="true" />

      {booted && (
      <motion.header
        className="head"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 380, damping: 32 }}
      >
        <div className="head-text" style={{ visibility: auth === "out" ? "hidden" : "visible" }}>
          <motion.div className="head-date" style={{ opacity: dateOpacity }}>{headerDate()}</motion.div>
          <motion.h1 className="head-title" style={{ scale: titleScale, y: titleY }}>
            <AnimatePresence mode="popLayout" initial={false} custom={dir}>
              <motion.span
                key={tab}
                custom={dir}
                initial={{ y: 18 * (dir || 1), opacity: 0, filter: "blur(4px)" }}
                animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
                exit={{ y: -18 * (dir || 1), opacity: 0, filter: "blur(4px)" }}
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                style={{ display: "inline-block" }}
              >
                {STATUS_LABEL[tab]}
              </motion.span>
            </AnimatePresence>
          </motion.h1>
        </div>
        <div className="head-actions">
          <AnimatePresence>
            {!online && (
              <motion.span className="offline glass" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} data-testid="offline" aria-label="オフライン">
                <Wifi size={16} />
              </motion.span>
            )}
          </AnimatePresence>
          {auth === "in" && (
            <motion.button className="mail-btn glass" whileTap={{ scale: 0.9 }} onClick={() => { haptic("light"); setMailOpen(true); }} aria-label="メール" data-testid="mail-open">
              <MailIcon size={20} />
              <AnimatePresence>
                {(unseen > 0 || mailAccount?.status === "expired") && (
                  <motion.i className={`mail-badge ${mailAccount?.status === "expired" ? "warn" : ""}`} data-testid="mail-badge" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={{ type: "spring", stiffness: 600, damping: 20 }} />
                )}
              </AnimatePresence>
            </motion.button>
          )}
          {auth === "in" && user && (
            <motion.button className="avatar glass" whileTap={{ scale: 0.9 }} onClick={() => setMenu((m) => !m)} aria-label="アカウント" data-testid="avatar">
              {user.picture ? <img src={user.picture} alt="" referrerPolicy="no-referrer" /> : <span>{(user.name || user.email).slice(0, 1).toUpperCase()}</span>}
            </motion.button>
          )}
        </div>
      </motion.header>
      )}

      <AnimatePresence>
        {menu && user && (
          <>
            <motion.div className="menu-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setMenu(false)} />
            <motion.div
              className="menu glass"
              data-testid="menu"
              initial={{ opacity: 0, scale: 0.6, filter: "blur(6px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, scale: 0.7, filter: "blur(6px)" }}
              transition={{ type: "spring", stiffness: 480, damping: 32 }}
            >
              <div className="menu-user">
                <strong>{user.name || user.email}</strong>
                <span>{user.email}</span>
              </div>
              <label className="menu-row">
                <span><Sparkle size={15} /> AIで自動整理</span>
                <input type="checkbox" role="switch" className="switch" checked={aiOn} onChange={(e) => setAiEnabled(e.target.checked)} data-testid="ai-toggle" />
              </label>
              <button className="menu-row danger" onClick={() => { setMenu(false); void logout(); }} data-testid="logout">ログアウト</button>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <main className="main">
        {booted && auth === "out" && (
          <motion.section
            className="login"
            data-testid="login"
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: "spring", stiffness: 320, damping: 30 }}
          >
            <img className="login-icon" src="/icon.svg" alt="" width={72} height={72} />
            <div className="login-name">Flick</div>
            <motion.button className="google-btn glass" whileTap={{ scale: 0.96 }} onClick={login} data-testid="google-login">
              <Google size={20} />
              <span>Googleでログイン</span>
            </motion.button>
          </motion.section>
        )}

        <AnimatePresence>
          {booted && auth === "in" && latest && !latest.seen_at && latest.items.length > 0 && (
            <motion.button
              key={latest.id}
              className="mail-banner glass"
              data-testid="mail-banner"
              initial={{ opacity: 0, y: -24, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -16, scale: 0.96 }}
              transition={{ type: "spring", stiffness: 420, damping: 26 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => { haptic("light"); setMailOpen(true); }}
            >
              <span className="mail-banner-icon"><MailIcon size={20} /></span>
              <span className="mail-banner-text">
                <strong>{digestLabel(latest.created_at)} のメール {latest.items.length}件</strong>
                <span>
                  Gmail {countBy(latest).gmail}・iCloud {countBy(latest).icloud}
                  {countBy(latest).action > 0 && <em>要対応 {countBy(latest).action}</em>}
                </span>
              </span>
              <ChevronRight size={18} className="mail-banner-chev" />
            </motion.button>
          )}
        </AnimatePresence>

        {booted && (
          <AnimatePresence mode="popLayout" initial={false} custom={dir}>
            <motion.ul
              key={tab}
              className="list"
              data-testid={`list-${tab}`}
              custom={dir}
              variants={{
                enter: (d: number) => ({ x: d * 60, opacity: 0, filter: "blur(4px)" }),
                center: { x: 0, opacity: 1, filter: "blur(0px)" },
                exit: (d: number) => ({ x: d * -60, opacity: 0, filter: "blur(4px)" }),
              }}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ type: "spring", stiffness: 380, damping: 34 }}
            >
              <AnimatePresence initial={true}>
                {list.map((t, i) => (
                  <TaskCard key={t.id} task={t} index={i} onOpen={(x) => setOpenId(x.id)} onAction={onAction} onToggleDone={onToggleDone} />
                ))}
              </AnimatePresence>
              {list.length === 0 && auth !== "out" && (
                <motion.li
                  key="empty"
                  className="empty"
                  aria-label="タスクなし"
                  data-testid="empty"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.15 }}
                >
                  <Tray size={64} />
                </motion.li>
              )}
            </motion.ul>
          </AnimatePresence>
        )}
      </main>

      {booted && auth !== "out" && <Tabs value={tab} counts={counts} onChange={setTab} />}

      {booted && auth === "in" && (
        <div className="fabs">
          <motion.button
            className="fab-ai glass"
            aria-label="AIに頼む"
            data-testid="ai-open"
            disabled={!online}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: online ? 1 : 0.45 }}
            whileTap={{ scale: 0.88 }}
            transition={{ type: "spring", stiffness: 520, damping: 26, delay: 0.12 }}
            onClick={() => { haptic("light"); setAsking(true); }}
          >
            <Mic size={21} />
            <Sparkle size={11} className="fab-ai-spark" />
          </motion.button>
          <motion.button
            className="fab"
            aria-label="タスクを追加"
            data-testid="add"
            initial={{ scale: 0, rotate: -90, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            whileTap={{ scale: 0.88 }}
            transition={{ type: "spring", stiffness: 520, damping: 24, delay: 0.06 }}
            onClick={openAdd}
          >
            <Plus size={26} />
          </motion.button>
        </div>
      )}

      <TaskSheet taskId={openId} onClose={() => setOpenId(null)} onDelete={handleDelete} onComplete={onComplete} />
      <NewTaskSheet open={adding} defaultStatus={tab} onClose={closeAdd} onAdded={onAdded} />
      <AiSheet open={asking} onClose={closeAsk} onAdded={onAiAdded} />
      <MailView open={mailOpen} onClose={closeMail} toast={showToast} />

      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            className="toast glass"
            role="status"
            data-testid="toast"
            initial={{ y: -40, opacity: 0, scale: 0.8 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -30, opacity: 0, scale: 0.85 }}
            transition={{ type: "spring", stiffness: 500, damping: 32 }}
          >
            <span>{toast.text}</span>
            {toast.undo && (
              <button onClick={() => { toast.undo?.(); setToast(null); }} data-testid="undo">取り消す</button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}
