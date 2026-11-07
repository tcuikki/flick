import { test, expect, type Page } from "@playwright/test";
import { ORIGIN, collectErrors, isoDate, login, ready } from "./helpers";

let errors: string[] = [];
test.beforeEach(({ page }) => {
  errors = collectErrors(page);
});
test.afterEach(() => {
  expect(errors, errors.join("\n")).toEqual([]);
});

const H = { origin: ORIGIN };
const connect = (page: Page, data: { token?: string; holiday?: string } = {}) => page.request.post("/api/cal/dev-connect", { headers: H, data });
const add = (page: Page, title: string, date: string, s: string, e: string, extra: Record<string, unknown> = {}) =>
  page.request.post("/api/cal/events", {
    headers: H,
    data: { calendarId: "primary", title, start: `${date}T${s}`, end: `${date}T${e}`, allDay: false, location: "", description: "", ...extra },
  });
async function serverEvents(page: Page, date: string) {
  const res = await page.request.get(`/api/cal/events?date=${date}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()).events as { id: string; title: string; start: string; end: string; allDay: boolean; location: string; description: string }[];
}
const ev = (page: Page, title: string) => page.locator(`[data-testid=event][data-title="${title}"]`);

test.describe("今日（Google カレンダー）", () => {
  test("開くと最初は「今日」。カレンダーをつないでいなければ「つなぐ」を出し、予定の編集の許可で Google へ", async ({ page }) => {
    await login(page);
    await page.goto("/");
    await ready(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("今日");
    await expect(page.getByTestId("nav-today")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("cal-connect-card")).toContainText("Googleカレンダーをつなぐ");
    await expect(page.getByTestId("event-add")).toHaveCount(0);

    const res = await page.request.get("/api/cal/connect", { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    const url = new URL(res.headers()["location"]);
    expect(url.hostname).toBe("accounts.google.com");
    const scope = url.searchParams.get("scope")!;
    expect(scope).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(scope).toContain("https://www.googleapis.com/auth/calendar.calendarlist.readonly");
    expect(scope).not.toMatch(/auth\/calendar(\s|$)/); // カレンダーの設定ごとの全権限は求めない
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toContain("select_account");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("その日の予定が縦の時間割に、時刻どおりの位置と長さで並ぶ。重なる予定は横に分ける", async ({ page }) => {
    await login(page);
    const today = isoDate(0);
    await connect(page, { holiday: today });
    await add(page, "1限 データベース", today, "09:00", "10:30", { location: "1号館" });
    await add(page, "ゼミ", today, "13:00", "14:30");
    await add(page, "面談の準備", today, "13:30", "14:00");
    await page.goto("/");
    await ready(page);

    await expect(page.getByTestId("day-date")).toContainText(`${Number(today.slice(5, 7))}月${Number(today.slice(8))}日`);
    await expect(ev(page, "1限 データベース")).toContainText("9:00〜10:30");
    await expect(ev(page, "1限 データベース")).toContainText("1号館");
    // 終日の予定（読むだけの祝日カレンダー）は上の段
    await expect(page.getByTestId("allday").getByTestId("event")).toHaveText("テストの祝日");

    const tl = (await page.getByTestId("timeline").boundingBox())!;
    const db = (await ev(page, "1限 データベース").boundingBox())!;
    const zemi = (await ev(page, "ゼミ").boundingBox())!;
    const prep = (await ev(page, "面談の準備").boundingBox())!;
    const hour = tl.height / 24;
    expect(Math.abs(db.y - tl.y - 9 * hour)).toBeLessThan(2);
    expect(Math.abs(db.height - 1.5 * hour)).toBeLessThan(4);
    expect(Math.abs(zemi.y - tl.y - 13 * hour)).toBeLessThan(2);
    // 重なる予定は横に並ぶ（左右に分かれ、重ならない）
    expect(prep.x).toBeGreaterThan(zemi.x + zemi.width - 2);
    expect(zemi.width).toBeLessThan(db.width * 0.6);

    // 今日なら「今」の赤い線
    await expect(page.getByTestId("now-line")).toBeAttached();
  });

  test("「＋予定」から追加すると、Google カレンダーに保存されて時間割に出る", async ({ page }) => {
    await login(page);
    await connect(page);
    await page.goto("/");
    await ready(page);
    await expect(page.getByTestId("day-empty")).toContainText("今日の予定はありません");
    await page.getByTestId("event-add").tap();
    const sheet = page.getByTestId("event-sheet");
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId("event-save")).toBeDisabled(); // タイトルが空のうちは押せない
    await page.getByTestId("event-title").fill("企業説明会（オンライン）");
    await page.getByTestId("event-start").fill("15:00");
    await expect(page.getByTestId("event-end")).toHaveValue("16:00"); // 開始をずらすと終わりも一緒に動く
    await page.getByTestId("event-end").fill("16:30");
    await page.getByTestId("event-location").fill("Zoom");
    await page.getByTestId("event-save").tap();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId("toast")).toContainText("予定を追加しました");
    await expect(ev(page, "企業説明会（オンライン）")).toContainText("15:00〜16:30");
    const saved = await serverEvents(page, isoDate(0));
    expect(saved).toMatchObject([{ title: "企業説明会（オンライン）", start: `${isoDate(0)}T15:00`, end: `${isoDate(0)}T16:30`, allDay: false, location: "Zoom" }]);
  });

  test("空いている時間を押すと、その時刻から始まる予定を追加できる", async ({ page }) => {
    await login(page);
    await connect(page);
    await page.goto("/");
    await ready(page);
    await expect(page.getByTestId("day-empty")).toBeVisible();
    const scroller = page.getByTestId("timeline-scroll");
    await scroller.evaluate((el) => (el.scrollTop = 13 * 56));
    const tl = (await page.getByTestId("timeline").boundingBox())!;
    const hour = tl.height / 24;
    await page.mouse.click(tl.x + tl.width * 0.6, tl.y + 14.2 * hour);
    await expect(page.getByTestId("event-start")).toHaveValue("14:00");
    await expect(page.getByTestId("event-end")).toHaveValue("15:00");
    await page.getByTestId("event-title").fill("課題をする");
    await page.getByTestId("event-title").press("Enter");
    await expect(ev(page, "課題をする")).toBeVisible();
    expect((await serverEvents(page, isoDate(0)))[0]).toMatchObject({ title: "課題をする", start: `${isoDate(0)}T14:00` });
  });

  test("予定を押すと変更できる（タイトル・時刻・終日・メモ）", async ({ page }) => {
    await login(page);
    const today = isoDate(0);
    await connect(page);
    await add(page, "ゼミ", today, "13:00", "14:30");
    await page.goto("/");
    await ready(page);
    await ev(page, "ゼミ").tap();
    await expect(page.getByTestId("event-title")).toHaveValue("ゼミ");
    await expect(page.getByTestId("event-start")).toHaveValue("13:00");
    await page.getByTestId("event-title").fill("ゼミ（発表）");
    await page.getByTestId("event-end").fill("15:00");
    await page.getByTestId("event-note").fill("スライドを持っていく");
    await page.getByTestId("event-save").tap();
    await expect(page.getByTestId("toast")).toContainText("予定を変更しました");
    await expect(ev(page, "ゼミ（発表）")).toContainText("13:00〜15:00");
    await expect(ev(page, "ゼミ")).toHaveCount(0);
    expect((await serverEvents(page, today))[0]).toMatchObject({ title: "ゼミ（発表）", end: `${today}T15:00`, description: "スライドを持っていく" });

    // 終日に変える → 上の段に移る
    await ev(page, "ゼミ（発表）").tap();
    await page.getByTestId("event-allday").check();
    await expect(page.getByTestId("event-start")).toHaveCount(0);
    await page.getByTestId("event-save").tap();
    await expect(page.getByTestId("allday").getByTestId("event")).toHaveText("ゼミ（発表）");
    expect((await serverEvents(page, today))[0]).toMatchObject({ allDay: true, start: today, end: isoDate(1) });
  });

  test("削除は2回押して確定。押すと Google カレンダーからも消える", async ({ page }) => {
    await login(page);
    const today = isoDate(0);
    await connect(page);
    await add(page, "消す予定", today, "18:00", "19:00");
    await page.goto("/");
    await ready(page);
    await ev(page, "消す予定").tap();
    await page.getByTestId("event-delete").tap();
    await expect(page.getByTestId("event-delete")).toContainText("削除する"); // 1回目は確認だけ
    expect(await serverEvents(page, today)).toHaveLength(1);
    await page.getByTestId("event-delete").tap();
    await expect(page.getByTestId("event-sheet")).toHaveCount(0);
    await expect(ev(page, "消す予定")).toHaveCount(0);
    await expect.poll(async () => (await serverEvents(page, today)).length).toBe(0);
  });

  test("読むだけのカレンダー（祝日など）の予定は、開けるが変更・削除はできない", async ({ page }) => {
    await login(page);
    await connect(page, { holiday: isoDate(0) });
    await page.goto("/");
    await ready(page);
    await page.getByTestId("allday").getByTestId("event").tap();
    await expect(page.getByTestId("event-readonly")).toBeVisible();
    await expect(page.getByTestId("event-save")).toHaveCount(0);
    await expect(page.getByTestId("event-delete")).toHaveCount(0);
    const res = await page.request.post("/api/cal/events", {
      headers: H, data: { calendarId: "holidays", title: "x", start: isoDate(0), end: isoDate(1), allDay: true },
    });
    expect(res.status()).toBe(403);
  });

  test("日付を前後に動かせて、「今日」で戻る", async ({ page }) => {
    await login(page);
    await connect(page);
    await add(page, "明日の面接", isoDate(1), "10:00", "11:00");
    await page.goto("/");
    await ready(page);
    await expect(ev(page, "明日の面接")).toHaveCount(0);
    await page.getByTestId("day-next").tap();
    await expect(page.getByTestId("day-nav")).toContainText("明日");
    await expect(ev(page, "明日の面接")).toBeVisible();
    await expect(page.getByTestId("now-line")).toHaveCount(0);
    await page.getByTestId("day-today").tap();
    await expect(page.getByTestId("day-nav")).toContainText("今日");
    await expect(ev(page, "明日の面接")).toHaveCount(0);
    await page.getByTestId("day-prev").tap();
    await expect(page.getByTestId("day-nav")).toContainText("昨日");
  });

  test("許可が切れたら「つなぎ直す」を出す", async ({ page }) => {
    await login(page);
    await connect(page, { token: "expired" });
    await page.goto("/");
    await ready(page);
    await expect(page.getByTestId("cal-expired")).toContainText("接続が切れました");
    await expect(page.getByTestId("cal-reconnect")).toBeVisible();
    const res = await page.request.post("/api/cal/events", {
      headers: H, data: { calendarId: "primary", title: "x", start: `${isoDate(0)}T10:00`, end: `${isoDate(0)}T11:00`, allDay: false },
    });
    expect(res.status()).toBe(409);
  });

  test("カレンダーの API はログインが必要。おかしな入力は弾き、他人の予定は見えない", async ({ page, playwright }) => {
    const anon = await playwright.request.newContext({ baseURL: ORIGIN });
    expect((await anon.get(`/api/cal/events?date=${isoDate(0)}`)).status()).toBe(401);
    await anon.dispose();

    await login(page);
    await connect(page);
    expect((await page.request.get("/api/cal/events?date=2026-13-99x")).status()).toBe(400);
    const bad = [
      { title: "", start: `${isoDate(0)}T10:00`, end: `${isoDate(0)}T11:00` },
      { title: "逆", start: `${isoDate(0)}T11:00`, end: `${isoDate(0)}T10:00` },
      { title: "形式", start: "10:00", end: "11:00" },
    ];
    for (const b of bad) {
      const r = await page.request.post("/api/cal/events", { headers: H, data: { calendarId: "primary", allDay: false, ...b } });
      expect(r.status()).toBe(400);
    }
    expect((await page.request.post("/api/cal/events", { headers: { origin: "https://evil.example" }, data: {} })).status()).toBe(403);
    await add(page, "自分の予定", isoDate(0), "10:00", "11:00");

    // 別のユーザー
    await page.context().clearCookies();
    await login(page, "Other");
    expect((await page.request.get(`/api/cal/events?date=${isoDate(0)}`)).ok()).toBeTruthy();
    expect((await (await page.request.get(`/api/cal/events?date=${isoDate(0)}`)).json()).source).toBeNull();
    await connect(page);
    expect(await serverEvents(page, isoDate(0))).toEqual([]);
  });
});

test.describe("タスクのページ", () => {
  test("上の「未着手・進行中・完了」を押すと一覧が横にスライドして切り替わる", async ({ page }) => {
    await login(page);
    await page.goto("/");
    await ready(page);
    await page.getByTestId("nav-tasks").tap();
    await expect(page.getByTestId("status-tabs")).toBeVisible();
    await expect(page.getByTestId("tab-todo")).toHaveAttribute("aria-selected", "true");
    const status = (await page.getByTestId("status-tabs").boundingBox())!;
    const nav = (await page.getByTestId("nav-tasks").boundingBox())!;
    expect(status.y).toBeLessThan(200); // 上にある
    expect(nav.y).toBeGreaterThan(600); // 下のタブは「今日・メール・タスク」
    await expect(page.locator("[role=tablist][aria-label=画面] [role=tab]")).toHaveText(["今日", "メール", "タスク"]);

    await page.getByTestId("tab-done").tap();
    await page.waitForTimeout(40);
    // 切り替えの途中は、前の一覧と次の一覧が横にずれて重なっている
    const moving = await page.locator(".list").evaluateAll((els) => els.map((e) => new DOMMatrix(getComputedStyle(e).transform).m41));
    expect(moving.some((x) => Math.abs(x) > 1)).toBeTruthy();
    await expect(page.getByTestId("list-done")).toBeVisible();
    await expect(page.getByTestId("tab-done")).toHaveAttribute("aria-selected", "true");
  });
});
