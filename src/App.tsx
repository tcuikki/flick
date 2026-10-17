import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, MotionConfig, motion, useScroll, useTransform } from "motion/react";
import {
  STATUS_LABEL, type Status, type Task,
  addTask, breakdown, deleteTask, drainBootQueue, login, logout, restoreTask, setAiEnabled, setStatus, useStore,
} from "./store";
import { headerDate } from "./date";
import { haptic } from "./haptics";
import { TaskCard } from "./components/TaskCard";
import { TaskSheet } from "./components/TaskSheet";
import { Tabs } from "./components/Tabs";
import { ArrowUp, Google, Sparkle, Tray, Wifi } from "./components/Icons";

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

  /* ---------- 静的 HTML の入力欄を引き継ぐ ---------- */
  useEffect(() => {
    const w = window as any;
    w.__flickAdd = (text: string) => {
      addTask(text);
      haptic("light");
      setTab("todo");
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    drainBootQueue();
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (e.key === "/" && !(el && /INPUT|TEXTAREA/.test(el.tagName))) {
        e.preventDefault();
        document.getElementById("compose-input")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const params = new URLSearchParams(location.search);
    if (params.get("login") === "failed") {
      showToast("ログインできませんでした");
      history.replaceState(null, "", "/");
    }
    return () => {
      w.__flickAdd = undefined;
      window.removeEventListener("keydown", onKey);
    };
  }, [setTab, showToast]);

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

  const onBreakdown = useCallback(
    async (t: Task) => {
      try {
        const created = await breakdown(t);
        if (!created.length) return showToast("分解できませんでした");
        haptic("success");
        setOpenId(null);
        setTab("todo");
        showToast(`${created.length}件追加しました`);
      } catch {
        showToast("AIに接続できませんでした");
      }
    },
    [setTab, showToast],
  );

  /* ---------- ヘッダーのスクロール演出（大きなタイトル → 縮小 + スクロールエッジ） ---------- */
  const { scrollY } = useScroll();
  const titleScale = useTransform(scrollY, [0, 80], [1, 0.62]);
  const titleY = useTransform(scrollY, [0, 80], [0, 34]);
  const dateOpacity = useTransform(scrollY, [0, 40], [1, 0]);
  const edgeOpacity = useTransform(scrollY, [10, 60], [0, 1]);

  return (
    <MotionConfig reducedMotion="user">
      <ComposerSendButton />

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

      <TaskSheet taskId={openId} onClose={() => setOpenId(null)} onDelete={handleDelete} onBreakdown={onBreakdown} />

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

/** 静的 HTML の入力欄に、文字があるときだけ送信ボタンを出す（React Portal） */
function ComposerSendButton() {
  const [has, setHas] = useState(false);
  const slot = useRef<HTMLElement | null>(document.getElementById("composer-slot"));
  useEffect(() => {
    const input = document.getElementById("compose-input") as HTMLInputElement | null;
    if (!input) return;
    const on = () => setHas(input.value.trim().length > 0);
    on();
    input.addEventListener("input", on);
    // 送信後（ブートスクリプトが value を空にする）にも反映
    const form = input.form;
    const onSubmit = () => setTimeout(on, 0);
    form?.addEventListener("submit", onSubmit);
    return () => {
      input.removeEventListener("input", on);
      form?.removeEventListener("submit", onSubmit);
    };
  }, []);
  if (!slot.current) return null;
  return createPortal(
    <AnimatePresence>
      {has && (
        <motion.button
          type="submit"
          className="send"
          aria-label="追加"
          data-testid="send"
          initial={{ scale: 0, opacity: 0, rotate: -90 }}
          animate={{ scale: 1, opacity: 1, rotate: 0 }}
          exit={{ scale: 0, opacity: 0, rotate: 90 }}
          whileTap={{ scale: 0.85 }}
          transition={{ type: "spring", stiffness: 600, damping: 28 }}
          onPointerDown={(e) => e.preventDefault() /* 入力欄のフォーカス（＝キーボード）を保つ */}
        >
          <ArrowUp size={18} />
        </motion.button>
      )}
    </AnimatePresence>,
    slot.current,
  );
}
