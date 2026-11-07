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
import { StatusTabs } from "./components/StatusTabs";
import { BottomNav, PAGES, PAGE_LABEL, type Page } from "./components/BottomNav";
import { NewTaskSheet } from "./components/NewTaskSheet";
import { AiSheet } from "./components/AiSheet";
import { MailView } from "./components/MailView";
import { TodayView } from "./components/TodayView";
import { EventSheet, type EventDraft } from "./components/EventSheet";
import { SLOTS, SLOT_LABEL, autoCheck, loadMail, useMail } from "./mail";
import { clearCalCache, loadDay, today, useCal } from "./calendar";
import { primeKeyboard } from "./focus";
import { Google, Mic, Plus, Sparkle, Tray, Wifi } from "./components/Icons";

type Toast = { id: number; text: string; undo?: () => void };
const MIN_SKELETON_MS = 450;
/** 画面を開いている間のメールの自動更新の間隔 */
const MAIL_POLL_MS = 60_000;
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
  // 開いたら最初は「今日」。メール・カレンダーをつないで戻ってきたときはそのページ
  const [page, setPageState] = useState<Page>(() => {
    const q = new URLSearchParams(location.search);
    return q.get("mail") === "connected" ? "mail" : "today";
  });
  const [pageDir, setPageDir] = useState(0);
  const [eventDraft, setEventDraft] = useState<EventDraft | null>(null);
  // 「今日」のページで見ている日（右下の ＋ とマイクは、この日の予定を入れる）
  const [calDate, setCalDate] = useState(today);
  const calOk = useCal((c) => c.source?.status === "ok");
  const [booted, setBooted] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [menu, setMenu] = useState(false);
  const [adding, setAdding] = useState(false);
  const [asking, setAsking] = useState(false);
  const mailExpired = useMail((m) => m.sources.some((s) => s.status === "expired"));
  // 選び出した配列を毎回作ると再描画が止まらなくなるので、元のデータだけ購読して useMemo で計算する
  const mailItems = useMail((m) => m.items);
  // 溜まっている未読（今日の一番上と、下のタブの数字に出す）
  const unread = useMemo(() => mailItems.filter((m) => !m.read), [mailItems]);

  const goPage = useCallback((p: Page) => {
    setPageState((cur) => {
      if (cur !== p) {
        setPageDir(Math.sign(PAGES.indexOf(p) - PAGES.indexOf(cur)));
        window.scrollTo({ top: 0 });
      }
      return p;
    });
  }, []);
  const closeEvent = useCallback(() => setEventDraft(null), []);
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
      goPage("tasks");
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [setTab, goPage],
  );
  /** 「今日」の ＋：見ている日の予定を追加（今日なら次の30分区切りから、ほかの日は9:00から） */
  const openEventAdd = useCallback(() => {
    haptic("light");
    if (!calOk) { showToast("先に「カレンダーをつなぐ」を押してください"); return; }
    const now = new Date();
    const start = calDate === today() ? Math.min(23 * 60, Math.ceil((now.getHours() * 60 + now.getMinutes() + 1) / 30) * 30) : 9 * 60;
    setEventDraft({ mode: "new", date: calDate, startMin: start });
  }, [calOk, calDate, showToast]);
  const onAiEventsAdded = useCallback(
    (n: number) => {
      setAsking(false);
      void loadDay(calDate);
      showToast(`${n}件の予定を入れました`);
    },
    [calDate, showToast],
  );

  const onAiAdded = useCallback(
    (n: number) => {
      setAsking(false);
      setTab("todo");
      goPage("tasks");
      window.scrollTo({ top: 0, behavior: "smooth" });
      showToast(`${n}件追加しました`);
    },
    [setTab, goPage, showToast],
  );

  /* ---------- メール：開いている間は自動で読み込み、届いたら知らせる ---------- */
  useEffect(() => {
    if (auth !== "in") return;
    let alive = true;
    const run = async () => {
      if (document.visibilityState !== "visible") return;
      const arrived = await autoCheck();
      if (!alive || !arrived.length) return;
      haptic("light");
      const one = arrived.length === 1 ? arrived[0] : null;
      showToast(
        one
          ? `新着メール（${SLOT_LABEL[one.slot]}）：${one.subject.slice(0, 28)}`
          : `新着メール ${arrived.length}件（${SLOTS.filter((s) => arrived.some((m) => m.slot === s)).map((s) => `${SLOT_LABEL[s]} ${arrived.filter((m) => m.slot === s).length}`).join("・")}）`,
      );
    };
    void loadMail().then(run);
    const timer = setInterval(run, MAIL_POLL_MS);
    const onVis = () => void run();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    window.addEventListener("online", onVis);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
      window.removeEventListener("online", onVis);
    };
  }, [auth, showToast]);

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
      const msg: Record<string, string> = {
        connected: "つなぎました。数秒で読み込みます",
        denied: "メールを読む許可がありませんでした（チェックを入れて許可してください）",
        "ms-admin": "大学の設定で、管理者の承認が必要でした",
        "ms-notready": "大学のOutlookは、Microsoft側の準備がまだです",
      };
      showToast(msg[mail] ?? "つなげませんでした");
      if (mail === "connected") { goPage("mail"); setTimeout(() => void loadMail(), 4000); }
      history.replaceState(null, "", "/");
    }
    const cal = params.get("cal");
    if (cal) {
      const msg: Record<string, string> = {
        connected: "カレンダーをつなぎました",
        denied: "カレンダーの許可がありませんでした（チェックを入れて許可してください）",
      };
      showToast(msg[cal] ?? "カレンダーにつなげませんでした");
      goPage("today");
      if (cal === "connected") void loadDay(today());
      history.replaceState(null, "", "/");
    }
    return () => window.removeEventListener("keydown", onKey);
  }, [showToast, goPage]);

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

  const taskList = (
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
  );

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
            <AnimatePresence mode="popLayout" initial={false} custom={pageDir}>
              <motion.span
                key={page}
                custom={pageDir}
                initial={{ y: 18 * (pageDir || 1), opacity: 0, filter: "blur(4px)" }}
                animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
                exit={{ y: -18 * (pageDir || 1), opacity: 0, filter: "blur(4px)" }}
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                style={{ display: "inline-block" }}
              >
                {PAGE_LABEL[page]}
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
              <button className="menu-row danger" onClick={() => { setMenu(false); clearCalCache(); void logout(); }} data-testid="logout">ログアウト</button>
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

        {booted && auth === "out" && taskList}

        {booted && auth !== "out" && (
          <AnimatePresence mode="popLayout" initial={false} custom={pageDir}>
            <motion.div
              key={page}
              className={`page page-${page}`}
              data-testid={`page-${page}`}
              custom={pageDir}
              variants={{
                enter: (d: number) => ({ x: d * 70, opacity: 0 }),
                center: { x: 0, opacity: 1 },
                exit: (d: number) => ({ x: d * -70, opacity: 0 }),
              }}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ type: "spring", stiffness: 380, damping: 36 }}
            >
              {page === "today" && (
                <TodayView date={calDate} setDate={setCalDate} unread={unread} onOpenMail={() => goPage("mail")} onEdit={setEventDraft} />
              )}
              {page === "mail" && <MailView active toast={showToast} />}
              {page === "tasks" && (
                <>
                  <StatusTabs value={tab} counts={counts} onChange={setTab} />
                  {taskList}
                </>
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </main>

      {booted && auth !== "out" && (
        <BottomNav value={page} onChange={goPage} mailBadge={unread.length} mailWarn={mailExpired} taskCount={counts.todo + counts.doing} />
      )}

      {booted && auth === "in" && page !== "mail" && (
        <div className="fabs">
          <motion.button
            className="fab-ai glass"
            aria-label={page === "today" ? "話して予定を入れる" : "AIに頼む"}
            data-testid="ai-open"
            disabled={!online}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: online ? 1 : 0.45 }}
            whileTap={{ scale: 0.88 }}
            transition={{ type: "spring", stiffness: 520, damping: 26, delay: 0.12 }}
            onClick={() => {
              haptic("light");
              if (page === "today" && !calOk) { showToast("先に「カレンダーをつなぐ」を押してください"); return; }
              setAsking(true);
            }}
          >
            <Mic size={21} />
            <Sparkle size={11} className="fab-ai-spark" />
          </motion.button>
          <motion.button
            className="fab"
            aria-label={page === "today" ? "予定を追加" : "タスクを追加"}
            data-testid="add"
            initial={{ scale: 0, rotate: -90, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            whileTap={{ scale: 0.88 }}
            transition={{ type: "spring", stiffness: 520, damping: 24, delay: 0.06 }}
            onClick={page === "today" ? openEventAdd : openAdd}
          >
            <Plus size={26} />
          </motion.button>
        </div>
      )}

      <TaskSheet taskId={openId} onClose={() => setOpenId(null)} onDelete={handleDelete} onComplete={onComplete} />
      <NewTaskSheet open={adding} defaultStatus={tab} onClose={closeAdd} onAdded={onAdded} />
      <AiSheet
        open={asking}
        mode={page === "today" ? "events" : "tasks"}
        baseDate={calDate}
        onClose={closeAsk}
        onAdded={page === "today" ? onAiEventsAdded : onAiAdded}
      />
      <EventSheet draft={eventDraft} onClose={closeEvent} toast={showToast} />

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
