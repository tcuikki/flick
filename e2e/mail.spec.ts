import { test, expect, type Page } from "@playwright/test";
import { ORIGIN, settled, card, collectErrors, login, ready, serverTasks } from "./helpers";

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
    await page.getByTestId("nav-mail").tap();
    await expect(page.getByTestId("mail-view")).toBeVisible();
    await expect(page.getByTestId("mail-view").getByRole("tab")).toHaveText(["個人", "事業", "大学"]);
    // 更新の時刻は出さない（自動で読み込むので）
    await expect(page.getByTestId("mail-updated")).toHaveCount(0);
    await expect(page.getByTestId("mail-check")).toHaveCount(0);
    await expect(page.getByTestId("mail-connect-card-personal")).toContainText("個人のGmailをつなぐ");
    await page.getByTestId("mail-tab-business").tap();
    await expect(page.getByTestId("mail-connect-card-business")).toContainText("AIHP");
    await page.getByTestId("mail-tab-univ").tap();
    await expect(page.getByTestId("mail-connect-card-univ")).toContainText("受け皿のGmail");
    // メールのページでは、タスクの＋は出さない（下のタブは出したまま）
    await expect(page.locator(".fabs")).toHaveCount(0);
    await expect(page.getByTestId("nav-mail")).toHaveAttribute("aria-selected", "true");
    await page.getByTestId("nav-today").tap();
    await expect(page.getByTestId("mail-view")).toHaveCount(0);
    await expect(page.getByTestId("today")).toBeVisible();
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
    await page.getByTestId("nav-mail").tap();
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

    // 大学：受け皿の Gmail を Google でつなぐ（Microsoft のアプリ登録は大学の設定でできなかった）
    const r = await page.request.get("/api/mail/connect/univ", { maxRedirects: 0 });
    expect(r.status()).toBe(302);
    expect(r.headers()["location"]).toContain("accounts.google.com/o/oauth2/v2/auth");
    expect(r.headers()["location"]).toContain(encodeURIComponent("https://www.googleapis.com/auth/gmail.readonly"));
  });

  test("受信箱を新着順に、未読つきで出す。押すとアプリの中で説明が出て既読になる", async ({ page }) => {
    await login(page);
    await devConnect(page, "personal");
    await devConnect(page, "business");
    await devConnect(page, "univ");
    await cron(page);
    await page.goto("/");
    await ready(page);
    await page.getByTestId("nav-mail").tap();

    // 未読の数が枠ごとに出る
    await expect(page.getByTestId("mail-unread-personal")).toHaveText("2");
    await expect(page.getByTestId("mail-unread-business")).toHaveText("1");
    await expect(page.getByTestId("mail-unread-univ")).toHaveText("1");

    // 個人：新着順（面接 → カード → タイムセール）。分類の見出しは無い
    await page.getByTestId("mail-tab-personal").tap();
    await expect(page.getByTestId("mail-count")).toContainText("未読 2件");
    await expect(rows(page).locator(".mail-subject")).toHaveText(["一次面接日程のご案内", "カードご利用のお知らせ", "タイムセール開催中"]);
    await expect(page.getByText("要対応")).toHaveCount(0);
    await expect(rows(page).nth(2)).toHaveAttribute("data-read", "1");

    // カードのお知らせを押す → 外へ飛ばず、本文の全文をアプリの中で表示。既読になる
    await rows(page).nth(1).tap();
    const detail = page.getByTestId("mail-detail");
    await expect(detail).toBeVisible();
    await expect(page).toHaveURL(/workers\.dev|localhost/);
    // ISO-2022-JP（日本語のメールでよくある文字コード）でも文字化けしない
    await expect(page.getByTestId("mail-detail-body")).toContainText("三井住友カードをご利用いただきありがとうございます。");
    await expect(page.getByTestId("mail-detail-body")).toContainText("ご利用金額：3,280円");
    await expect(page.getByTestId("mail-detail-body")).toContainText("※本メールは送信専用です。");
    await expect(page.getByText("AIの説明")).toHaveCount(0); // AI の説明は出さない
    await expect(page.getByTestId("mail-open-original")).toHaveAttribute("target", "_blank");
    await page.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);
    await expect(rows(page).nth(1)).toHaveAttribute("data-read", "1");
    await expect(page.getByTestId("mail-unread-personal")).toHaveText("1");
    // 既読はサーバーにも残る
    await page.reload();
    await ready(page);
    await page.getByTestId("nav-mail").tap();
    await page.getByTestId("mail-tab-personal").tap();
    await expect(rows(page).nth(1)).toHaveAttribute("data-read", "1");

    // HTML のメールは文字だけにして表示（スクリプトや見た目の指定は出さない）
    await rows(page).nth(0).tap();
    const body = page.getByTestId("mail-detail-body");
    await expect(body).toContainText("日時：11月12日 10:00〜");
    await expect(body).toContainText("ご確認のほど よろしくお願いいたします。");
    await expect(body).not.toContainText("alert");
    await expect(body).not.toContainText("color:red");
    await page.keyboard.press("Escape");

    // 大学：受け皿の Gmail（大学の Outlook から転送）
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
    await page.getByTestId("nav-mail").tap();
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

  test("メールの中身から「タスクにする」で未着手に入る（件名がタスク名になる）", async ({ page }) => {
    await login(page);
    await devConnect(page, "univ");
    await cron(page);
    await page.goto("/");
    await ready(page);
    await page.getByTestId("nav-mail").tap();
    await page.getByTestId("mail-tab-univ").tap();
    await rows(page).nth(0).tap();
    await expect(page.getByTestId("mail-detail-body")).toContainText("本文のテストです。");
    await page.getByTestId("mail-to-task").tap();
    await expect(page.getByTestId("mail-to-task")).toContainText("追加しました");
    await expect.poll(async () => (await serverTasks(page)).map((t) => t.title)).toEqual(["【至急】履修登録の確認について"]);
    expect((await serverTasks(page))[0].note).toContain("東京都市大学 教務課");
    await page.keyboard.press("Escape");
    await page.getByTestId("nav-tasks").tap();
    await expect(card(page, "【至急】履修登録の確認について")).toBeVisible();
  });

  test("「今日」の一番上に、溜まっている未読を「個人 2・大学 1」のように出す。読むと減り、全部読むと消える", async ({ page }) => {
    await login(page);
    await devConnect(page, "personal");
    await devConnect(page, "univ");
    await cron(page);
    await page.goto("/");
    await ready(page);
    const banner = page.getByTestId("mail-banner");
    await expect(banner).toContainText("メールが 3件 来ています");
    await expect(page.getByTestId("mail-banner-personal")).toHaveText("個人 2");
    await expect(page.getByTestId("mail-banner-univ")).toHaveText("大学 1");
    await expect(page.getByTestId("mail-banner-business")).toHaveCount(0);
    // 今日のページの一番上（予定より上）
    const b = (await banner.boundingBox())!;
    const nav = (await page.getByTestId("day-nav").boundingBox())!;
    expect(b.y).toBeLessThan(nav.y);
    await expect(page.getByTestId("mail-badge")).toHaveText("3");

    // メールを開いただけでは消えない（まだ読んでいないので）
    await banner.tap();
    await settled(page, "mail");
    await expect(page.getByTestId("mail-view")).toBeVisible();
    await page.getByTestId("nav-today").tap();
    await settled(page, "today");
    await expect(banner).toContainText("メールが 3件 来ています");

    // 個人を全部読むと、大学だけが残る
    await page.getByTestId("nav-mail").tap();
    await settled(page, "mail");
    await page.getByTestId("mail-tab-personal").tap();
    await page.getByTestId("mail-read-all").tap();
    await page.getByTestId("nav-today").tap();
    await settled(page, "today");
    await expect(banner).toContainText("メールが 1件 来ています");
    await expect(page.getByTestId("mail-banner-personal")).toHaveCount(0);
    await expect(page.getByTestId("mail-badge")).toHaveText("1");

    // 全部読むと消える（開き直しても出ない）
    await page.getByTestId("nav-mail").tap();
    await settled(page, "mail");
    await page.getByTestId("mail-tab-univ").tap();
    await page.getByTestId("mail-read-all").tap();
    await page.getByTestId("nav-today").tap();
    await settled(page, "today");
    await expect(banner).toHaveCount(0);
    await expect(page.getByTestId("mail-badge")).toHaveCount(0);
    await page.reload();
    await ready(page);
    await page.waitForTimeout(500);
    await expect(page.getByTestId("mail-banner")).toHaveCount(0);
  });

  test("開いている間は自動で読み込み、届いたメールはボタンを押さなくても出る（トーストと今日のお知らせ）", async ({ page }) => {
    await login(page);
    const email = `auto${Date.now()}@gmail.com`;
    await page.request.post("/api/mail/dev-connect", { headers: { origin: ORIGIN }, data: { slot: "personal", email } });
    await page.goto("/");
    await ready(page);
    // 開いたときに自動で読み込む（↻ を押さなくても）
    await expect(page.getByTestId("mail-banner")).toContainText("メールが 2件 来ています");
    await expect(page.getByTestId("mail-banner")).not.toContainText("更新");

    // 新しいメールが1通届く → サーバーの自動更新（5分ごと）→ 画面は1分ごと・戻ったときに読み直す
    await page.request.post("/api/mail/dev-new", { headers: { origin: ORIGIN } });
    await cron(page);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByTestId("toast").filter({ hasText: "新着メール（個人）：新しい予定の招待" })).toBeVisible();
    await expect(page.getByTestId("mail-banner")).toContainText("メールが 3件 来ています");
    await expect(page.getByTestId("mail-badge")).toHaveText("3");
  });

  test("Gmail（ほかの端末）で読んだメールは Flick でも既読になる。Flick で「未読に戻す」をしたメールは勝手に戻さない", async ({ page }) => {
    await login(page);
    const email = `sync${Date.now()}@gmail.com`;
    await page.request.post("/api/mail/dev-connect", { headers: { origin: ORIGIN }, data: { slot: "personal", email } });
    await cron(page);
    const readOf = async (id: string) => ((await (await page.request.get("/api/mail")).json()).items as any[]).find((m) => m.id === id).read;
    expect(await readOf("g1")).toBe(false);
    // g3 は Gmail では既読。Flick で未読に戻しておく
    await page.request.post("/api/mail/items/personal/g3/read", { headers: { origin: ORIGIN }, data: { read: false } });
    // g1 を Gmail で読む
    await page.request.post("/api/mail/dev-gmail-read", { headers: { origin: ORIGIN }, data: { id: "g1" } });
    await cron(page);
    expect(await readOf("g1")).toBe(true);
    expect(await readOf("g2")).toBe(false);
    expect(await readOf("g3")).toBe(false);
  });

  test("メールのページの一番上で下に引っぱると、丸い点が出て読み込む", async ({ page }) => {
    await login(page);
    await devConnect(page, "personal");
    await page.goto("/");
    await ready(page);
    await page.getByTestId("nav-mail").tap();
    await settled(page, "mail");
    await page.waitForTimeout(6_000); // 開いたときの自動読み込みから間を空ける（引っぱったときは5秒あけば読みに行く）
    const forced: unknown[] = [];
    page.on("request", (r) => { if (r.url().endsWith("/api/mail/check")) forced.push(r.postDataJSON()); });
    const pull = page.getByTestId("pull-refresh");
    await expect(pull).toHaveAttribute("data-state", "idle");
    const cdp = await page.context().newCDPSession(page);
    const x = 200;
    let y = 260;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 0; i < 12; i++) {
      y += 16;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
      await page.waitForTimeout(16);
    }
    await expect(pull).toHaveAttribute("data-state", "ready");
    expect(await pull.locator("i").count()).toBe(5);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(pull).toHaveAttribute("data-state", "refreshing");
    await expect(page.getByTestId("toast")).toContainText("新しいメールはありません");
    await expect(pull).toHaveAttribute("data-state", "idle");
    expect(forced).toContainEqual({ force: true });
    await cdp.detach();
  });

  test("少しだけ引いて離したときは読み込まない。横のスワイプでも読み込まない", async ({ page }) => {
    await login(page);
    await devConnect(page, "personal");
    await page.goto("/");
    await ready(page);
    await page.getByTestId("nav-mail").tap();
    await settled(page, "mail");
    let forced = 0;
    page.on("request", (r) => { if (r.url().endsWith("/api/mail/check") && (r.postDataJSON() as any)?.force) forced++; });
    const cdp = await page.context().newCDPSession(page);
    const drag = async (dx: number, dy: number) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 200, y: 260 }] });
      for (let i = 1; i <= 8; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 200 + (dx * i) / 8, y: 260 + (dy * i) / 8 }] });
        await page.waitForTimeout(16);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    await drag(0, 60); // 30px しか引いていない
    await drag(160, 40); // 横
    await page.waitForTimeout(800);
    expect(forced).toBe(0);
    await expect(page.getByTestId("pull-refresh")).toHaveAttribute("data-state", "idle");
    await cdp.detach();
  });

  test("画面を開いている間は1分ごとに自動で読み込む", async ({ page }) => {
    await login(page);
    await devConnect(page, "personal");
    await page.clock.install();
    let checks = 0;
    let lists = 0;
    page.on("request", (r) => { if (r.url().endsWith("/api/mail/check") && r.method() === "POST") checks++; });
    page.on("requestfinished", (r) => { if (r.url().endsWith("/api/mail") && r.method() === "GET") lists++; });
    await page.goto("/");
    await ready(page);
    // 開いたとき：一覧 → 読み込み → 一覧
    await expect.poll(() => checks).toBe(1);
    await expect.poll(() => lists).toBe(2);
    // 1分たつごとに、もう一度読み込む（前の読み込みが終わってから次の1分を進める）
    await page.clock.runFor(61_000);
    await expect.poll(() => checks).toBe(2);
    await expect.poll(() => lists).toBe(3);
    await page.clock.runFor(61_000);
    await expect.poll(() => checks).toBe(3);
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

  test("キーワードで検索できる。受信箱にない古いメール（取り込んだ就活のメール）も見つかる", async ({ page }) => {
    await login(page);
    await devConnect(page, "personal");
    await devConnect(page, "univ");
    await cron(page);
    await page.goto("/");
    await ready(page);
    await page.getByTestId("nav-mail").tap();
    await page.getByTestId("mail-tab-personal").tap();
    await page.getByTestId("mail-search").fill("面接");
    await page.getByTestId("mail-search").press("Enter");
    await expect(page.getByTestId("mail-search-count")).toContainText("「面接」");
    await expect(page.getByTestId("mail-search-count")).toContainText("1件");
    await expect(page.getByTestId("mail-search-results").getByTestId("mail-row")).toHaveCount(1);
    await expect(page.getByTestId("mail-search-results")).toContainText("一次面接日程のご案内");

    // 枠を変えると同じ言葉で探し直す。大学の受け皿に取り込んだ4か月前の就活メールも見つかる
    await page.getByTestId("mail-search").fill("インターンシップ");
    await page.getByTestId("mail-search").press("Enter");
    await expect(page.getByTestId("mail-search-count")).toContainText("0件");
    await page.getByTestId("mail-tab-univ").tap();
    await expect(page.getByTestId("mail-search-results")).toContainText("インターンシップ選考結果のご連絡");
    await page.getByTestId("mail-search-results").getByTestId("mail-row").first().tap();
    await expect(page.getByTestId("mail-detail-body")).toContainText("本文のテストです。");
    await expect(page.getByTestId("mail-toggle-read")).toHaveCount(0); // 一覧に無いメールは既読を切り替えない
    await page.keyboard.press("Escape");

    // × で検索をやめると、受信箱の一覧に戻る
    await page.getByTestId("mail-search-clear").tap();
    await expect(page.getByTestId("mail-count")).toBeVisible();
    await expect(rows(page)).toHaveCount(2);
  });

  test("「すべて既読にする」でその枠の未読が0になる（ほかの枠はそのまま）", async ({ page }) => {
    await login(page);
    await devConnect(page, "personal");
    await devConnect(page, "univ");
    await cron(page);
    await page.goto("/");
    await ready(page);
    await page.getByTestId("nav-mail").tap();
    await page.getByTestId("mail-tab-personal").tap();
    await expect(page.getByTestId("mail-unread-personal")).toHaveText("2");
    await page.getByTestId("mail-read-all").tap();
    await expect(page.getByTestId("mail-count")).toContainText("未読 0件");
    await expect(page.getByTestId("mail-unread-personal")).toHaveCount(0);
    await expect(page.getByTestId("mail-read-all")).toHaveCount(0);
    await expect(page.getByTestId("mail-unread-univ")).toHaveText("1");
    await expect.poll(async () => (await (await page.request.get("/api/mail")).json()).items.filter((m: any) => m.slot === "personal" && !m.read).length).toBe(0);
  });

  test("許可が切れた枠には「つなぎ直す」を出し、ほかの枠は読み込める", async ({ page }) => {
    await login(page);
    await devConnect(page, "personal", "expired");
    await devConnect(page, "univ");
    const r = await (await page.request.post("/api/mail/check", { headers: { origin: ORIGIN } })).json();
    expect(r.result).toEqual({ personal: "expired", univ: "ok" });
    await page.goto("/");
    await ready(page);
    await page.getByTestId("nav-mail").tap();
    await page.getByTestId("mail-tab-personal").tap();
    await expect(page.getByTestId("mail-expired")).toContainText("個人との接続が切れました");
    await page.getByTestId("mail-tab-univ").tap();
    await expect(rows(page)).toHaveCount(2);
    // 続けざまの読み込み（15秒以内）は Gmail を読みに行かずに飛ばす
    expect(await (await page.request.post("/api/mail/check", { headers: { origin: ORIGIN } })).json()).toEqual({ skipped: true });
  });

  test("メールの API はログインが必要で、他人のメールの既読は変えられない。トークンは返さない", async ({ page, playwright }) => {
    const anon = await playwright.request.newContext({ baseURL: ORIGIN });
    expect((await anon.get("/api/mail")).status()).toBe(401);
    expect((await anon.get("/api/mail/connect/personal", { maxRedirects: 0 })).status()).toBe(401);
    expect((await anon.get("/api/mail/search?slot=personal&q=x")).status()).toBe(401);
    expect((await anon.get("/api/mail/items/personal/g1/body")).status()).toBe(401);
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
