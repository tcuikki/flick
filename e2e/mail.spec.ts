import { test, expect, type Page } from "@playwright/test";
import { ORIGIN, card, collectErrors, login, ready, serverTasks } from "./helpers";

let errors: string[] = [];
test.beforeEach(({ page }) => {
  errors = collectErrors(page);
});
test.afterEach(() => {
  expect(errors, errors.join("\n")).toEqual([]);
});

const devConnect = (page: Page, slot: "personal" | "business" | "univ", token = "e2e-refresh") =>
  page.request.post("/api/mail/dev-connect", {
    headers: { origin: ORIGIN },
    data: { slot, token, email: slot === "business" ? "aihp@example.com" : undefined },
  });
const cron = (page: Page) => page.request.post("/api/mail/dev-cron", { headers: { origin: ORIGIN } });
const rows = (page: Page) => page.getByTestId("mail-row");

test.describe("メール（個人・事業・大学）", () => {
  test("枠は 個人 → 事業 → 大学 の順。つないでいない枠には「つなぐ」を出す", async ({ page }) => {
    await login(page);
    await page.goto("/");
    await ready(page);
    await page.getByTestId("mail-open").tap();
    await expect(page.getByTestId("mail-view")).toBeVisible();
    await expect(page.getByTestId("mail-view").getByRole("tab")).toHaveText(["個人", "事業", "大学"]);
    await expect(page.getByTestId("mail-updated")).toHaveText("毎日 10:00 と 20:00 に更新");
    await expect(page.getByTestId("mail-connect-card-personal")).toContainText("個人のGmailをつなぐ");
    await page.getByTestId("mail-tab-business").tap();
    await expect(page.getByTestId("mail-connect-card-business")).toContainText("AIHP");
    await page.getByTestId("mail-tab-univ").tap();
    await expect(page.getByTestId("mail-connect-card-univ")).toContainText("転送はしません");
    // メールの画面のあいだは、タスクの＋とタブは隠す（別の枠）
    await expect(page.locator(".fabs")).toHaveCSS("opacity", "0");
    await page.getByTestId("mail-close").tap();
    await expect(page.getByTestId("mail-view")).toHaveCount(0);
  });

  test("Gmail は読むだけの権限で、別のアカウントも選べる。大学は Microsoft の読むだけの権限", async ({ page }) => {
    await login(page);
    const seen: string[] = [];
    page.on("request", (req) => {
      const u = req.url();
      if (u.includes("accounts.google.com/o/oauth2/v2/auth") || u.includes("login.microsoftonline.com")) seen.push(u);
    });
    await page.context().route(/accounts\.google\.com|login\.microsoftonline\.com/, (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<title>login</title>" }),
    );
    await page.goto("/");
    await ready(page);
    await page.getByTestId("mail-open").tap();
    await page.getByTestId("mail-tab-business").tap();
    await page.getByTestId("mail-connect").tap();
    await expect.poll(() => seen.length).toBeGreaterThan(0);
    const g = new URL(seen[0]);
    expect(g.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(g.searchParams.get("scope")).not.toMatch(/gmail\.(modify|send)/);
    expect(g.searchParams.get("access_type")).toBe("offline");
    expect(g.searchParams.get("prompt")).toContain("select_account");
    expect(g.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/google/callback`);
    expect((await page.context().cookies()).find((c) => c.name === "flick_oauth_purpose")?.value).toBe("mail-business");

    // 大学：E2E では Microsoft のアプリ ID が無いので「準備がまだ」に戻る（本番は Microsoft のログインへ）
    const r = await page.request.get("/api/mail/connect/univ", { maxRedirects: 0 });
    expect(r.status()).toBe(302);
    expect(r.headers()["location"]).toBe("/?mail=ms-notready");
  });

  test("受信箱を新着順に、未読つきで出す。押すとアプリの中で説明が出て既読になる", async ({ page }) => {
    await login(page);
    await devConnect(page, "personal");
    await devConnect(page, "business");
    await devConnect(page, "univ");
    await cron(page);
    await page.goto("/");
    await ready(page);
    await page.getByTestId("mail-open").tap();

    // 未読の数が枠ごとに出る
    await expect(page.getByTestId("mail-unread-personal")).toHaveText("2");
    await expect(page.getByTestId("mail-unread-business")).toHaveText("1");
    await expect(page.getByTestId("mail-unread-univ")).toHaveText("1");
    await expect(page.getByTestId("mail-updated")).toContainText("に更新・次は");

    // 個人：新着順（面接 → カード → タイムセール）。分類の見出しは無い
    await page.getByTestId("mail-tab-personal").tap();
    await expect(page.getByTestId("mail-count")).toContainText("未読 2件");
    await expect(rows(page).locator(".mail-subject")).toHaveText(["一次面接日程のご案内", "カードご利用のお知らせ", "タイムセール開催中"]);
    await expect(page.getByText("要対応")).toHaveCount(0);
    await expect(rows(page).nth(2)).toHaveAttribute("data-read", "1");

    // カードのお知らせを押す → 外へ飛ばず、AI の説明と冒頭を表示。既読になる
    await rows(page).nth(1).tap();
    const detail = page.getByTestId("mail-detail");
    await expect(detail).toBeVisible();
    await expect(page).toHaveURL(/workers\.dev|localhost/);
    await expect(page.getByTestId("mail-detail-summary")).toContainText("3,280円");
    await expect(page.getByTestId("mail-detail-snippet")).toContainText("ご利用先 Amazon");
    await expect(page.getByTestId("mail-open-original")).toHaveAttribute("target", "_blank");
    await page.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);
    await expect(rows(page).nth(1)).toHaveAttribute("data-read", "1");
    await expect(page.getByTestId("mail-unread-personal")).toHaveText("1");
    // 既読はサーバーにも残る
    await page.reload();
    await ready(page);
    await page.getByTestId("mail-open").tap();
    await page.getByTestId("mail-tab-personal").tap();
    await expect(rows(page).nth(1)).toHaveAttribute("data-read", "1");

    // 大学：Outlook を直接読んだメール
    await page.getByTestId("mail-tab-univ").tap();
    await expect(rows(page).locator(".mail-subject")).toHaveText(["【至急】履修登録の確認について", "模擬面接のお知らせ"]);
    // 事業：AIHP の Gmail
    await page.getByTestId("mail-tab-business").tap();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toContainText("ホームページ修正のお願い");
  });

  test("左右にスワイプで 既読 ⇄ 未読", async ({ page }) => {
    await login(page);
    await devConnect(page, "personal");
    await cron(page);
    await page.goto("/");
    await ready(page);
    await page.getByTestId("mail-open").tap();
    await page.getByTestId("mail-tab-personal").tap();
    const target = rows(page).nth(0);
    await expect(target).toHaveAttribute("data-read", "0");
    const swipe = async (dx: number) => {
      const b = (await target.boundingBox())!;
      const cdp = await page.context().newCDPSession(page);
      const y = b.y + b.height / 2;
      const x0 = b.x + b.width / 2;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
      for (let i = 1; i <= 10; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + (dx * i) / 10, y }] });
        await page.waitForTimeout(12);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
    };
    await swipe(-200);
    await expect(target).toHaveAttribute("data-read", "1");
    await expect(page.getByTestId("mail-detail")).toHaveCount(0); // スワイプでは中身を開かない
    await swipe(200);
    await expect(target).toHaveAttribute("data-read", "0");
    await expect.poll(async () => (await (await page.request.get("/api/mail")).json()).items.find((m: any) => m.id === "g2")?.read).toBe(false);
  });

  test("メールの中身から「タスクにする」で未着手に入る（AI のやることの案と締切つき）", async ({ page }) => {
    await login(page);
    await devConnect(page, "univ");
    await cron(page);
    await page.goto("/");
    await ready(page);
    await page.getByTestId("mail-open").tap();
    await page.getByTestId("mail-tab-univ").tap();
    await expect(rows(page).nth(0)).toContainText("やることあり");
    await rows(page).nth(0).tap();
    await expect(page.getByTestId("mail-detail")).toContainText("履修登録の内容を確認して提出する");
    await page.getByTestId("mail-to-task").tap();
    await expect(page.getByTestId("mail-to-task")).toContainText("追加しました");
    await expect.poll(async () => (await serverTasks(page)).map((t) => [t.title, t.due_date])).toEqual([["履修登録の内容を確認して提出する", "2026-11-10"]]);
    expect((await serverTasks(page))[0].note).toContain("【至急】履修登録の確認について");
    await page.keyboard.press("Escape");
    await page.getByTestId("mail-close").tap();
    await expect(card(page, "履修登録の内容を確認して提出する")).toBeVisible();
  });

  test("自動更新で新しいメールが来ると一覧の上にお知らせ。メールを開いて閉じると消える", async ({ page }) => {
    await login(page);
    await devConnect(page, "personal");
    await devConnect(page, "univ");
    await cron(page);
    await page.goto("/");
    await ready(page);
    const banner = page.getByTestId("mail-banner");
    await expect(banner).toContainText("新しいメール 3件");
    await expect(banner).toContainText("個人 2・大学 1");
    await expect(page.getByTestId("mail-badge")).toBeVisible();
    await banner.tap();
    await expect(page.getByTestId("mail-view")).toBeVisible();
    await page.getByTestId("mail-close").tap();
    await expect(banner).toHaveCount(0);
    await expect(page.getByTestId("mail-badge")).toHaveCount(0);
    await page.reload();
    await ready(page);
    await page.waitForTimeout(500);
    await expect(page.getByTestId("mail-banner")).toHaveCount(0);
  });

  test("2回目の更新では、新しいメールだけ読み込み、既読は保ったまま", async ({ page }) => {
    await login(page);
    await devConnect(page, "personal");
    await cron(page);
    const before = (await (await page.request.get("/api/mail")).json()).items;
    await page.request.post(`/api/mail/items/personal/g1/read`, { headers: { origin: ORIGIN }, data: { read: true } });
    await cron(page);
    const after = (await (await page.request.get("/api/mail")).json()).items;
    expect(after.map((m: any) => m.id)).toEqual(before.map((m: any) => m.id));
    expect(after.find((m: any) => m.id === "g1").read).toBe(true);
  });

  test("許可が切れた枠には「つなぎ直す」を出し、ほかの枠は読み込める", async ({ page }) => {
    await login(page);
    await devConnect(page, "personal", "expired");
    await devConnect(page, "univ");
    const r = await (await page.request.post("/api/mail/check", { headers: { origin: ORIGIN } })).json();
    expect(r.result).toEqual({ personal: "expired", univ: "ok" });
    await page.goto("/");
    await ready(page);
    await page.getByTestId("mail-open").tap();
    await page.getByTestId("mail-tab-personal").tap();
    await expect(page.getByTestId("mail-expired")).toContainText("個人との接続が切れました");
    await page.getByTestId("mail-tab-univ").tap();
    await expect(rows(page)).toHaveCount(2);
    // 1分以内の「今すぐ更新」は待ってもらう
    expect((await page.request.post("/api/mail/check", { headers: { origin: ORIGIN } })).status()).toBe(429);
  });

  test("メールの API はログインが必要で、他人のメールの既読は変えられない。トークンは返さない", async ({ page, playwright }) => {
    const anon = await playwright.request.newContext({ baseURL: ORIGIN });
    expect((await anon.get("/api/mail")).status()).toBe(401);
    expect((await anon.get("/api/mail/connect/personal", { maxRedirects: 0 })).status()).toBe(401);
    await anon.dispose();

    await login(page, "A");
    await devConnect(page, "personal", "secret-refresh-token");
    await cron(page);
    const b = await playwright.request.newContext({ baseURL: ORIGIN });
    await b.post("/api/auth/dev-login", { headers: { origin: ORIGIN }, data: { email: `b${Date.now()}@example.com` } });
    expect((await (await b.get("/api/mail")).json()).items).toEqual([]);
    await b.post("/api/mail/items/personal/g1/read", { headers: { origin: ORIGIN }, data: { read: true } });
    await b.dispose();
    const body = await (await page.request.get("/api/mail")).text();
    expect(JSON.parse(body).items.find((m: any) => m.id === "g1").read).toBe(false);
    expect(body).not.toContain("secret-refresh-token");
    expect(body).not.toContain("token_enc");
  });
});
