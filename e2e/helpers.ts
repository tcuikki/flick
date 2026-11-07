import { expect, type Locator, type Page } from "@playwright/test";

export const ORIGIN = "http://localhost:8788";

let seq = 0;
/** テスト用ログイン（E2E 環境だけにあるエンドポイント）。ユーザーはテストごとに分ける */
export async function login(page: Page, name = "Tester") {
  const email = `t${Date.now()}-${seq++}@example.com`;
  const res = await page.request.post("/api/auth/dev-login", { headers: { origin: ORIGIN }, data: { email, name } });
  expect(res.ok()).toBeTruthy();
  return email;
}

export async function ready(page: Page) {
  await expect(page.getByTestId("skeleton")).toHaveCount(0, { timeout: 8000 });
}

/** 下のタブで「タスク」のページへ（開いた直後は「今日」） */
export async function gotoTasks(page: Page) {
  const nav = page.getByTestId("nav-tasks");
  if ((await nav.getAttribute("aria-selected")) !== "true") await nav.tap();
  await settled(page, "tasks");
}

/** 未着手・進行中・完了の切り替えで一覧が横にスライドしている途中なら、終わるまで待つ */
export async function listSettled(page: Page) {
  await expect(page.locator(".list")).toHaveCount(1);
  await expect
    .poll(() => page.locator(".list").evaluate((e) => { const t = getComputedStyle(e).transform; return t === "none" ? 0 : Math.abs(new DOMMatrix(t).m41); }))
    .toBeLessThan(0.5);
}

/** ページの横スライドが終わるまで待つ（動いている途中のタップやフリックは位置がずれる） */
export async function settled(page: Page, name: "today" | "mail" | "tasks") {
  const el = page.getByTestId(`page-${name}`);
  await expect(el).toBeVisible();
  await expect(page.locator(".page")).toHaveCount(1);
  await expect
    .poll(() => el.evaluate((e) => { const t = getComputedStyle(e).transform; return t === "none" ? 0 : Math.abs(new DOMMatrix(t).m41); }))
    .toBeLessThan(0.5);
}

/** ＋ボタン → やることを打って Enter（状態・期限は既定のまま） */
export async function addMemo(page: Page, text: string) {
  if (await page.getByTestId("nav-tasks").count()) await gotoTasks(page);
  await page.getByTestId("add").tap();
  const sheet = page.getByTestId("new-sheet");
  await expect(sheet).toBeVisible();
  const input = page.getByTestId("new-title");
  await input.fill(text);
  await input.press("Enter");
  await expect(sheet).toHaveCount(0);
}

export const card = (page: Page, title: string) => page.locator(`[data-testid=task][data-title="${title}"]`);

/** CDP で本物のタッチイベントを送ってフリックする（指で横に払う動き） */
export async function flick(page: Page, target: Locator, dx: number, steps = 10, stepMs = 12) {
  await listSettled(page);
  await expect(target.locator(".card")).toBeVisible();
  // カードが出てくる動き（下から浮き上がる）が終わってから払う
  await expect.poll(() => target.evaluate((e) => { const t = getComputedStyle(e).transform; return t === "none" ? 0 : Math.abs(new DOMMatrix(t).m42); })).toBeLessThan(0.5);
  const box = await target.locator(".card").boundingBox();
  if (!box) throw new Error("card not visible");
  const y = box.y + box.height / 2;
  const x0 = box.x + box.width / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + (dx * i) / steps, y }] });
    await page.waitForTimeout(stepMs);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

export async function serverTasks(page: Page) {
  const res = await page.request.get("/api/tasks");
  expect(res.ok()).toBeTruthy();
  return (await res.json()).tasks as { id: string; title: string; status: string; due_date: string | null; note: string }[];
}

/** ブラウザと同じ Asia/Tokyo の日付（CI の実行マシンは UTC なので、端末の時刻帯には頼らない） */
export function isoDate(offsetDays: number) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

/** ページで出たエラーを集める（各テストの最後に 0 件であることを確認） */
export function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // 未ログイン確認の 401 や、オフライン試験中の通信失敗は想定内
    if (/401|Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(t)) return;
    errors.push(`console: ${t}`);
  });
  return errors;
}

/**
 * ページ内で 120Hz 相当の間隔でポインターイベントを流す「素早い払い」。
 * CDP 経由だと 1 イベントごとの往復遅延で速度が実機より遅く測られるため、速度判定の検証はこちらで行う。
 */
export async function quickFlick(target: Locator, dx: number, durationMs = 60) {
  await target.locator(".card").evaluate(
    (el, { dx, durationMs }) =>
      new Promise<void>((resolve) => {
        const r = el.getBoundingClientRect();
        const x0 = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const opts = (x: number): PointerEventInit => ({
          pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true,
          clientX: x, clientY: y, buttons: 1, button: 0,
        });
        el.dispatchEvent(new PointerEvent("pointerdown", opts(x0)));
        const steps = Math.max(3, Math.round(durationMs / 8));
        let i = 0;
        const tick = () => {
          i++;
          window.dispatchEvent(new PointerEvent("pointermove", opts(x0 + (dx * i) / steps)));
          if (i < steps) setTimeout(tick, durationMs / steps);
          else {
            window.dispatchEvent(new PointerEvent("pointerup", { ...opts(x0 + dx), buttons: 0 }));
            resolve();
          }
        };
        setTimeout(tick, durationMs / steps);
      }),
    { dx, durationMs },
  );
}
