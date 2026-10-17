import { test, expect, devices } from "@playwright/test";
import { ORIGIN, addMemo, card, collectErrors, flick, isoDate, login, quickFlick, ready, serverTasks } from "./helpers";

let errors: string[] = [];
test.beforeEach(({ page }) => {
  errors = collectErrors(page);
});
test.afterEach(() => {
  expect(errors, errors.join("\n")).toEqual([]);
});

/* ================= 即メモ ================= */

test.describe("開いた瞬間メモ", () => {
  test("入力欄は静的 HTML にあり、JS も CSS も描画をブロックしない", async ({ request }) => {
    const html = (await (await request.get("/")).text()).replace(/<noscript>[\s\S]*?<\/noscript>/g, "");
    expect(html).toMatch(/id="compose-input"[^>]*autofocus/);
    // JS は module（defer 相当）、バンドル CSS は非同期読み込み
    const scripts = [...html.matchAll(/<script\b[^>]*src=[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(s).toContain('type="module"');
    const sheets = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)].map((m) => m[0]);
    for (const l of sheets) expect(l).toContain('media="print"');
  });

  test("JS バンドルが届く前に打ったメモも失われずタスクになる", async ({ page }) => {
    await login(page);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(/\/assets\/.*\.js$/, async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto("/", { waitUntil: "commit" });
    // React はまだ動いていない
    await expect(page.getByTestId("skeleton")).toBeVisible();
    await page.getByTestId("compose-input").fill("JSより先に書いたメモ");
    await page.getByTestId("compose-input").press("Enter");
    await expect(page.getByTestId("compose-input")).toHaveValue("");
    release();
    await expect(card(page, "JSより先に書いたメモ")).toBeVisible();
    await expect.poll(async () => (await serverTasks(page)).map((t) => t.title)).toContain("JSより先に書いたメモ");
  });

  test("書きかけのメモは閉じても残る", async ({ page }) => {
    await login(page);
    await page.goto("/");
    await ready(page);
    await page.getByTestId("compose-input").fill("書きかけ");
    await page.reload();
    await expect(page.getByTestId("compose-input")).toHaveValue("書きかけ");
  });

  test("PC ではページを開いた時点で入力欄にフォーカスがある", async ({ browser }) => {
    const ctx = await browser.newContext({ ...devices["Desktop Chrome"], baseURL: ORIGIN, serviceWorkers: "block" });
    const page = await ctx.newPage();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("compose-input")).toBeFocused();
    await page.keyboard.type("すぐ打てる");
    await expect(page.getByTestId("compose-input")).toHaveValue("すぐ打てる");
    await ctx.close();
  });

  test("Enter で追加 → 未着手の先頭に出て、サーバーにも保存される", async ({ page }) => {
    await login(page);
    await page.goto("/");
    await ready(page);
    await addMemo(page, "一つ目");
    await addMemo(page, "二つ目");
    await expect(page.getByTestId("count-todo")).toHaveText("2");
    await expect(page.getByTestId("task").first()).toHaveAttribute("data-title", "二つ目");
    await expect.poll(async () => (await serverTasks(page)).length).toBe(2);
    await page.reload();
    await ready(page);
    await expect(card(page, "一つ目")).toBeVisible();
  });

  test("送信ボタンは文字があるときだけ現れ、押すと追加される", async ({ page }) => {
    await login(page);
    await page.goto("/");
    await ready(page);
    await expect(page.getByTestId("send")).toHaveCount(0);
    await page.getByTestId("compose-input").fill("ボタンで追加");
    await page.getByTestId("send").tap();
    await expect(card(page, "ボタンで追加")).toBeVisible();
    await expect(page.getByTestId("send")).toHaveCount(0);
  });
});

/* ================= スケルトン ================= */

test("全画面スケルトンがデータ取得まで表示され、その間もメモできる", async ({ page }) => {
  await login(page);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/me", async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/");
  const sk = page.getByTestId("skeleton");
  await expect(sk).toBeVisible();
  const box = await sk.boundingBox();
  const vp = page.viewportSize()!;
  expect(box!.width).toBeGreaterThanOrEqual(vp.width - 1);
  expect(box!.height).toBeGreaterThanOrEqual(vp.height - 1);
  await expect(sk.locator(".sk-card")).toHaveCount(6);
  await addMemo(page, "読み込み中のメモ");
  release();
  await ready(page);
  await expect(card(page, "読み込み中のメモ")).toBeVisible();
});

/* ================= フリック ================= */

test.describe("フリックでステータス管理", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto("/");
    await ready(page);
  });

  test("右フリックで 未着手 → 進行中 → 完了", async ({ page }) => {
    await addMemo(page, "フリック対象");
    await flick(page, card(page, "フリック対象"), 230);
    await expect(card(page, "フリック対象")).toHaveCount(0);
    await expect(page.getByTestId("count-doing")).toHaveText("1");
    await expect(page.getByTestId("count-todo")).toHaveText("0");

    await page.getByTestId("tab-doing").tap();
    await expect(card(page, "フリック対象")).toHaveAttribute("data-status", "doing");
    await flick(page, card(page, "フリック対象"), 230);
    await expect(page.getByTestId("count-done")).toHaveText("1");

    await page.getByTestId("tab-done").tap();
    await expect(card(page, "フリック対象")).toHaveAttribute("data-status", "done");
    await expect.poll(async () => (await serverTasks(page)).find((t) => t.title === "フリック対象")?.status).toBe("done");
  });

  test("左フリックで 完了 → 進行中 → 未着手 に戻る", async ({ page }) => {
    await addMemo(page, "戻す対象");
    await flick(page, card(page, "戻す対象"), 230);
    await page.getByTestId("tab-doing").tap();
    await flick(page, card(page, "戻す対象"), 230);
    await page.getByTestId("tab-done").tap();
    await flick(page, card(page, "戻す対象"), -230);
    await expect(page.getByTestId("count-doing")).toHaveText("1");
    await page.getByTestId("tab-doing").tap();
    await flick(page, card(page, "戻す対象"), -230);
    await expect(page.getByTestId("count-todo")).toHaveText("1");
    await page.getByTestId("tab-todo").tap();
    await expect(card(page, "戻す対象")).toHaveAttribute("data-status", "todo");
  });

  test("素早い短いフリック（速度判定）でも動く", async ({ page }) => {
    await addMemo(page, "速いフリック");
    // しきい値 (84px) より短い 64px を 60ms で払う → 速度で判定されて進む
    await quickFlick(card(page, "速いフリック"), 64, 60);
    await expect(page.getByTestId("count-doing")).toHaveText("1");
    // 同じ距離でもゆっくり (600ms) だと戻る
    await addMemo(page, "遅い払い");
    await quickFlick(card(page, "遅い払い"), 64, 600);
    await page.waitForTimeout(500);
    await expect(card(page, "遅い払い")).toHaveAttribute("data-status", "todo");
  });

  test("ゆっくり少しだけ動かした場合はキャンセルされ元に戻る", async ({ page }) => {
    await addMemo(page, "動かさない");
    await flick(page, card(page, "動かさない"), 50, 10, 40);
    await page.waitForTimeout(600);
    await expect(card(page, "動かさない")).toHaveAttribute("data-status", "todo");
    const box = await card(page, "動かさない").locator(".card").boundingBox();
    const row = await card(page, "動かさない").boundingBox();
    expect(Math.abs(box!.x - row!.x)).toBeLessThan(2);
  });

  test("縦スクロールではフリックにならない", async ({ page }) => {
    for (let i = 0; i < 12; i++) await addMemo(page, `縦${i}`);
    const target = card(page, "縦5");
    const box = (await target.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const x = box.x + box.width / 2;
    let y = box.y + box.height / 2;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 0; i < 10; i++) {
      y -= 25;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + i, y }] });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(500);
    await expect(page.getByTestId("count-todo")).toHaveText("12");
    await expect(page.getByTestId("count-doing")).toHaveText("0");
  });

  test("未着手を左フリックで削除 → 取り消しで復元", async ({ page }) => {
    await addMemo(page, "消して戻す");
    await flick(page, card(page, "消して戻す"), -230);
    await expect(card(page, "消して戻す")).toHaveCount(0);
    await expect(page.getByTestId("toast")).toContainText("削除しました");
    await page.getByTestId("undo").tap();
    await expect(card(page, "消して戻す")).toBeVisible();
    await page.waitForTimeout(5600);
    expect((await serverTasks(page)).map((t) => t.title)).toContain("消して戻す");
  });

  test("取り消さなければ数秒後にサーバーからも消える", async ({ page }) => {
    await addMemo(page, "本当に消す");
    await expect.poll(async () => (await serverTasks(page)).length).toBe(1);
    await flick(page, card(page, "本当に消す"), -230);
    await expect.poll(async () => (await serverTasks(page)).length, { timeout: 12_000 }).toBe(0);
  });

  test("丸をタップで完了（チェックが描かれてから移動）", async ({ page }) => {
    await addMemo(page, "タップで完了");
    await card(page, "タップで完了").getByTestId("check").tap();
    await expect(page.getByTestId("count-done")).toHaveText("1");
    await page.getByTestId("tab-done").tap();
    await card(page, "タップで完了").getByTestId("check").tap();
    await expect(page.getByTestId("count-todo")).toHaveText("1");
  });
});

/* ================= 詳細シート ================= */

test("タップで詳細シート → タイトル・期限・メモ・ステータスを編集して保存", async ({ page }) => {
  await login(page);
  await page.goto("/");
  await ready(page);
  await addMemo(page, "編集前");
  await card(page, "編集前").locator(".card-title").tap();
  const sheet = page.getByTestId("sheet");
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(500); // 出てくるアニメーションの完了を待つ
  await sheet.getByTestId("sheet-title").fill("編集後");
  await sheet.getByRole("button", { name: "今日" }).tap();
  await sheet.getByTestId("sheet-note").fill("補足メモ");
  await sheet.getByRole("radio", { name: "進行中" }).tap();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("count-doing")).toHaveText("1");
  await expect
    .poll(async () => (await serverTasks(page))[0])
    .toMatchObject({ title: "編集後", note: "補足メモ", status: "doing", due_date: isoDate(0) });
  await page.getByTestId("tab-doing").tap();
  await expect(card(page, "編集後").getByTestId("due")).toHaveText("今日");
});

test("シートは下へドラッグで閉じる", async ({ page }) => {
  await login(page);
  await page.goto("/");
  await ready(page);
  await addMemo(page, "ドラッグで閉じる");
  await card(page, "ドラッグで閉じる").locator(".card-title").tap();
  await expect(page.getByTestId("sheet")).toBeVisible();
  await page.waitForTimeout(600); // 出てくるアニメーションの完了を待つ
  const grab = page.locator(".grabber-zone");
  const b = (await grab.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const x = b.x + b.width / 2;
  let y = b.y + b.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 0; i < 10; i++) {
    y += 30;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    await page.waitForTimeout(14);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.getByTestId("sheet")).toHaveCount(0);
});

/* ================= AI ================= */

test.describe("AI (Workers AI)", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto("/");
    await ready(page);
  });

  test("自然文のメモからタスク名と期限を整理する", async ({ page }) => {
    await addMemo(page, "明日までに資料作成");
    await expect(card(page, "資料作成")).toBeVisible();
    await expect(card(page, "資料作成").getByTestId("due")).toHaveText("明日");
    await expect.poll(async () => (await serverTasks(page))[0]).toMatchObject({ title: "資料作成", due_date: isoDate(1) });
  });

  test("AI 自動整理はメニューからオフにできる", async ({ page }) => {
    await page.getByTestId("avatar").tap();
    await page.getByTestId("ai-toggle").uncheck();
    await page.locator(".menu-scrim").click({ position: { x: 10, y: 400 } });
    await addMemo(page, "明日までにそのまま");
    await page.waitForTimeout(800);
    await expect(card(page, "明日までにそのまま")).toBeVisible();
  });

  test("AIで分解すると子タスクが追加される", async ({ page }) => {
    await addMemo(page, "引っ越し");
    await card(page, "引っ越し").locator(".card-title").tap();
    await page.getByTestId("breakdown").tap();
    await expect(page.getByTestId("sheet")).toHaveCount(0);
    await expect(page.getByTestId("toast")).toContainText("3件追加しました");
    await expect(page.getByTestId("count-todo")).toHaveText("4");
    await expect(card(page, "引っ越しの準備")).toBeVisible();
    await expect(card(page, "引っ越しの準備").locator(".note")).toHaveText("↳ 引っ越し");
  });
});

/* ================= オフライン ================= */

test("オフラインでも追加・移動でき、復帰すると同期される", async ({ page, context }) => {
  await login(page);
  await page.goto("/");
  await ready(page);
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.getByTestId("offline")).toBeVisible();
  await addMemo(page, "電波なしで追加");
  await flick(page, card(page, "電波なしで追加"), 230);
  await expect(page.getByTestId("count-doing")).toHaveText("1");
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByTestId("offline")).toHaveCount(0);
  await expect.poll(async () => (await serverTasks(page))[0]).toMatchObject({ title: "電波なしで追加", status: "doing" });
});

/* ================= 認証 ================= */

test.describe("Google 認証", () => {
  test("未ログイン時はロゴと Google ボタンだけ（余計なコピーなし）", async ({ page }) => {
    await page.goto("/");
    await ready(page);
    const loginBox = page.getByTestId("login");
    await expect(loginBox).toBeVisible();
    expect((await loginBox.innerText()).replace(/\s+/g, " ").trim()).toBe("Flick Googleでログイン");
    await expect(page.getByRole("tab")).toHaveCount(0);
    // 本文の見えている文字はこれだけ
    const visible = (await page.locator("main").innerText()).replace(/\s+/g, " ").trim();
    expect(visible).toBe("Flick Googleでログイン");
  });

  test("Google ボタンで Google の認可画面へ（PKCE + state 付き）", async ({ page }) => {
    let authUrl = "";
    await page.route("https://accounts.google.com/**", async (route) => {
      authUrl = route.request().url();
      await route.fulfill({ status: 200, contentType: "text/html", body: "<title>google</title>" });
    });
    await page.goto("/");
    await ready(page);
    await page.getByTestId("google-login").tap();
    await expect.poll(() => authUrl).toContain("accounts.google.com/o/oauth2/v2/auth");
    const u = new URL(authUrl);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBeTruthy();
    expect(u.searchParams.get("state")).toBeTruthy();
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/google/callback`);
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === "flick_oauth_state")?.httpOnly).toBe(true);
  });

  test("state が一致しないコールバックは拒否され、ログインしない", async ({ page }) => {
    await page.goto("/api/auth/google/callback?code=fake&state=forged");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("toast")).toContainText("ログインできませんでした");
    await expect(page.getByTestId("login")).toBeVisible();
  });

  test("API はセッションなしで 401、別オリジンからの書き込みは 403", async ({ playwright }) => {
    const anon = await playwright.request.newContext({ baseURL: ORIGIN });
    expect((await anon.get("/api/tasks")).status()).toBe(401);
    expect((await anon.get("/api/me")).status()).toBe(401);
    expect((await anon.post("/api/auth/dev-login", { headers: { origin: "https://evil.example" } })).status()).toBe(403);
    expect((await anon.put("/api/tasks/00000000-0000-4000-8000-000000000000", { data: { title: "x" } })).status()).toBe(403);
    await anon.dispose();
  });

  test("他人のタスクは読めず、上書きもできない", async ({ page, playwright }) => {
    await login(page, "A");
    await page.goto("/");
    await ready(page);
    await addMemo(page, "Aの秘密");
    await expect.poll(async () => (await serverTasks(page)).length).toBe(1);
    const id = (await serverTasks(page))[0].id;

    const b = await playwright.request.newContext({ baseURL: ORIGIN });
    await b.post("/api/auth/dev-login", { headers: { origin: ORIGIN }, data: { email: `b${Date.now()}@example.com` } });
    expect((await (await b.get("/api/tasks")).json()).tasks).toEqual([]);
    const put = await b.put(`/api/tasks/${id}`, { headers: { origin: ORIGIN }, data: { title: "乗っ取り", updated_at: Date.now() } });
    expect(put.status()).toBe(404);
    await b.dispose();
    expect((await serverTasks(page))[0].title).toBe("Aの秘密");
  });

  test("ログイン前に書いたメモはログイン後に同期される", async ({ page }) => {
    await page.goto("/");
    await ready(page);
    await addMemo(page, "ログイン前のメモ");
    await expect(card(page, "ログイン前のメモ")).toBeVisible();
    await login(page);
    await page.reload();
    await ready(page);
    await expect(card(page, "ログイン前のメモ")).toBeVisible();
    await expect.poll(async () => (await serverTasks(page)).map((t) => t.title)).toContain("ログイン前のメモ");
  });

  test("ログアウトで端末内のデータも消え、ログイン画面に戻る", async ({ page }) => {
    await login(page);
    await page.goto("/");
    await ready(page);
    await addMemo(page, "ログアウト前");
    await expect.poll(async () => (await serverTasks(page)).length).toBe(1);
    await page.getByTestId("avatar").tap();
    await page.getByTestId("logout").tap();
    await expect(page.getByTestId("login")).toBeVisible();
    await expect(card(page, "ログアウト前")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("flick:tasks:v1"))).toBe("[]");
    expect((await page.request.get("/api/me")).status()).toBe(401);
  });
});

/* ================= デザイン / UI ================= */

test.describe("Liquid Glass / レイアウト", () => {
  test("ガラスは操作レイヤー（入力欄・タブ・シート）だけで、カードは不透明", async ({ page }) => {
    await login(page);
    await page.goto("/");
    await ready(page);
    await addMemo(page, "ガラス確認");
    const bf = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backdropFilter);
    expect(await bf("#composer")).toContain("blur");
    expect(await bf(".tabs")).toContain("blur");
    expect(await bf(".card")).toBe("none");
    const bg = await page.locator(".card").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgb(255, 255, 255)");
  });

  test("「透明度を下げる」設定ではガラスを不透明にする", async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
    await page.goto("/");
    expect(await page.locator("#composer").evaluate((el) => getComputedStyle(el).backdropFilter)).toBe("none");
  });

  test("タブを切り替えると選択レンズがアニメーションで移動する", async ({ page }) => {
    await login(page);
    await page.goto("/");
    await ready(page);
    const lens = page.locator(".tab-lens");
    const x0 = (await lens.boundingBox())!.x;
    await page.getByTestId("tab-done").tap();
    await page.waitForTimeout(60);
    const mid = (await lens.boundingBox())!.x;
    await page.waitForTimeout(700);
    const x1 = (await lens.boundingBox())!.x;
    expect(mid).toBeGreaterThan(x0);
    expect(Math.abs(mid - x1)).toBeGreaterThan(1); // 途中経過がある = 瞬間移動ではない（ばねで行き過ぎることもある）
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("完了");
  });

  test("iPhone SE の幅でも横スクロールが出ない", async ({ browser }) => {
    const ctx = await browser.newContext({ ...devices["iPhone SE"], baseURL: ORIGIN, serviceWorkers: "block" });
    const page = await ctx.newPage();
    await login(page);
    await page.goto("/");
    await ready(page);
    await addMemo(page, "とても長いタスク名".repeat(8));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await ctx.close();
  });

  test("PWA: マニフェストとアイコンが配信されている", async ({ request }) => {
    const m = await (await request.get("/manifest.webmanifest")).json();
    expect(m.display).toBe("standalone");
    for (const icon of m.icons) expect((await request.get(icon.src)).status()).toBe(200);
    expect((await request.get("/apple-touch-icon.png")).status()).toBe(200);
    expect((await request.get("/sw.js")).status()).toBe(200);
  });
});
