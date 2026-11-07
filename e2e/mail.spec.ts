import { test, expect, type Page } from "@playwright/test";
import { ORIGIN, card, collectErrors, login, ready, serverTasks } from "./helpers";

let errors: string[] = [];
test.beforeEach(({ page }) => {
  errors = collectErrors(page);
});
test.afterEach(() => {
  expect(errors, errors.join("\n")).toEqual([]);
});

const devConnect = (page: Page, token = "e2e-refresh") =>
  page.request.post("/api/mail/dev-connect", { headers: { origin: ORIGIN }, data: { token } });

test.describe("メール（Gmail・iCloud）", () => {
  test("つないでいないときは「Gmailをつなぐ」と iCloud の転送方法を出す", async ({ page }) => {
    await login(page);
    await page.goto("/");
    await ready(page);
    await page.getByTestId("mail-open").tap();
    const view = page.getByTestId("mail-view");
    await expect(view).toBeVisible();
    await expect(page.getByTestId("mail-connect-card")).toContainText("10:00 と 18:00");
    await expect(page.getByTestId("mail-connect-card")).toContainText("iCloud.com");
    // メールの画面のあいだは、タスクの＋とタブは隠す（別の枠）
    await expect(page.locator(".fabs")).toHaveCSS("opacity", "0");
    await page.getByTestId("mail-close").tap();
    await expect(view).toHaveCount(0);
  });

  test("「Gmailをつなぐ」は読むだけの権限（gmail.readonly）と、サーバーから読むための許可を求める", async ({ page }) => {
    await login(page);
    let authUrl = "";
    page.on("request", (req) => {
      if (!authUrl && req.url().includes("accounts.google.com/o/oauth2/v2/auth")) authUrl = req.url();
    });
    await page.context().route("https://accounts.google.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<title>google</title>" }),
    );
    await page.goto("/");
    await ready(page);
    await page.getByTestId("mail-open").tap();
    await page.getByTestId("mail-connect").tap();
    await expect.poll(() => authUrl).toContain("accounts.google.com/o/oauth2/v2/auth");
    const u = new URL(authUrl);
    expect(u.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(u.searchParams.get("scope")).not.toContain("gmail.modify");
    expect(u.searchParams.get("scope")).not.toContain("gmail.send");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/google/callback`); // 既存のリダイレクト URI を使う
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === "flick_oauth_purpose")?.value).toBe("mail");
  });

  test("チェックすると Gmail と iCloud に分けて、AI の要約とやることの案を出す", async ({ page }) => {
    await login(page);
    await devConnect(page);
    await page.goto("/");
    await ready(page);
    await page.getByTestId("mail-open").tap();
    await expect(page.getByTestId("mail-nodigest")).toBeVisible();
    await page.getByTestId("mail-check").tap();
    await expect(page.getByTestId("toast")).toContainText("4件のメールが届いています");
    await expect(page.getByTestId("digest-hero")).toContainText("4件");
    await expect(page.getByTestId("digest-hero")).toContainText("要対応 1");

    // Gmail：3件（広告は「広告・SNS」にまとめて閉じておく）
    await expect(page.getByTestId("mail-tab-gmail")).toContainText("Gmail 3");
    await expect(page.getByTestId("mail-tab-icloud")).toContainText("iCloud 1");
    await expect(page.getByTestId("mail-group-action")).toContainText("【至急】履修登録の確認について");
    await expect(page.getByTestId("mail-group-action")).toContainText("東京都市大学 教務課");
    await expect(page.getByTestId("mail-group-check")).toContainText("一次面接日程のご案内");
    await expect(page.getByTestId("mail-group-ad")).not.toContainText("タイムセール");
    await page.getByTestId("mail-ads-toggle").tap();
    await expect(page.getByTestId("mail-group-ad")).toContainText("タイムセール");
    // メールをタップすると Gmail で開く
    await expect(page.getByTestId("mail-row").first()).toHaveAttribute("href", /mail\.google\.com\/mail\/u\/\?authuser=tester%40gmail\.com#all\/t/);

    // iCloud：@icloud.com 宛てに届いて Gmail に転送されたもの
    await page.getByTestId("mail-tab-icloud").tap();
    await expect(page.getByTestId("mail-row")).toHaveCount(1);
    await expect(page.getByTestId("mail-row")).toContainText("iCloud ストレージの領収書");
    await expect(page.getByTestId("mail-tasks")).toHaveCount(0);

    // やることの案 → 未着手に追加（メールの件名がメモに入る）
    await page.getByTestId("mail-tab-gmail").tap();
    await expect(page.getByTestId("mail-tasks")).toContainText("履修登録の内容を確認して提出する");
    // メールの冒頭にある漢字だけで書かれているので「字を確認」は出ない
    await expect(page.getByTestId("mail-tasks").locator(".plan-warn")).toHaveCount(0);
    await page.getByTestId("mail-add-tasks").tap();
    await expect(page.getByTestId("mail-add-tasks")).toHaveText("追加しました");
    await expect.poll(async () => (await serverTasks(page)).map((t) => [t.title, t.status])).toEqual([["履修登録の内容を確認して提出する", "todo"]]);
    expect((await serverTasks(page))[0].note).toContain("【至急】履修登録の確認について");
    await page.getByTestId("mail-close").tap();
    await expect(card(page, "履修登録の内容を確認して提出する")).toBeVisible();
  });

  test("10:00 / 18:00 の自動チェックで届くと、一覧の上にお知らせが出て、開くと消える", async ({ page }) => {
    await login(page);
    await devConnect(page);
    // Cron と同じ処理を動かす
    expect((await page.request.post("/api/mail/dev-cron", { headers: { origin: ORIGIN } })).ok()).toBeTruthy();
    await page.goto("/");
    await ready(page);
    const banner = page.getByTestId("mail-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("のメール 4件");
    await expect(banner).toContainText("Gmail 3・iCloud 1");
    await expect(banner).toContainText("要対応 1");
    await expect(page.getByTestId("mail-badge")).toBeVisible();
    await banner.tap();
    await expect(page.getByTestId("mail-view")).toBeVisible();
    await page.getByTestId("mail-close").tap();
    await expect(banner).toHaveCount(0);
    await expect(page.getByTestId("mail-badge")).toHaveCount(0);
    // 既読はサーバーにも残る
    await page.reload();
    await ready(page);
    await page.waitForTimeout(500);
    await expect(page.getByTestId("mail-banner")).toHaveCount(0);
  });

  test("前回のチェックから1分以内の「今すぐチェック」は待ってもらう", async ({ page }) => {
    await login(page);
    await devConnect(page);
    expect((await page.request.post("/api/mail/check", { headers: { origin: ORIGIN } })).status()).toBe(200);
    expect((await page.request.post("/api/mail/check", { headers: { origin: ORIGIN } })).status()).toBe(429);
  });

  test("Google の許可が切れたら「つなぎ直す」を出す（テスト中のアプリは7日で切れる）", async ({ page }) => {
    await login(page);
    await devConnect(page, "expired");
    expect((await page.request.post("/api/mail/check", { headers: { origin: ORIGIN } })).status()).toBe(409);
    await page.goto("/");
    await ready(page);
    await expect(page.getByTestId("mail-badge")).toHaveClass(/warn/);
    await page.getByTestId("mail-open").tap();
    await expect(page.getByTestId("mail-expired")).toContainText("接続が切れました");
    await expect(page.getByTestId("mail-reconnect")).toBeVisible();
  });

  test("メールの API はログインが必要で、他人のまとめは既読にもできない", async ({ page, playwright }) => {
    const anon = await playwright.request.newContext({ baseURL: ORIGIN });
    expect((await anon.get("/api/mail")).status()).toBe(401);
    expect((await anon.get("/api/mail/connect", { maxRedirects: 0 })).status()).toBe(401);
    await anon.dispose();

    await login(page, "A");
    await devConnect(page);
    const d = (await (await page.request.post("/api/mail/check", { headers: { origin: ORIGIN } })).json()).digest;
    const b = await playwright.request.newContext({ baseURL: ORIGIN });
    await b.post("/api/auth/dev-login", { headers: { origin: ORIGIN }, data: { email: `b${Date.now()}@example.com` } });
    expect((await (await b.get("/api/mail")).json()).digests).toEqual([]);
    await b.post(`/api/mail/digests/${d.id}/seen`, { headers: { origin: ORIGIN } });
    await b.dispose();
    const mine = (await (await page.request.get("/api/mail")).json()).digests[0];
    expect(mine.seen_at).toBeNull();
  });

  test("Google のトークンは API の応答に出さない", async ({ page }) => {
    await login(page);
    await devConnect(page, "secret-refresh-token");
    expect((await page.request.post("/api/mail/check", { headers: { origin: ORIGIN } })).status()).toBe(200);
    const body = await (await page.request.get("/api/mail")).text();
    expect(body).not.toContain("secret-refresh-token");
    expect(body).not.toContain("token_enc");
  });
});
