import { test, expect, devices } from "@playwright/test";
import { ORIGIN, addMemo, card, collectErrors, flick, isoDate, login, quickFlick, ready, serverTasks } from "./helpers";

let errors: string[] = [];
test.beforeEach(({ page }) => {
  errors = collectErrors(page);
});
test.afterEach(() => {
  expect(errors, errors.join("\n")).toEqual([]);
});

/* ================= ＋ボタンで追加 ================= */

test.describe("＋ボタンで追加", () => {
  test("最初の描画は静的 HTML のスケルトンで、JS も CSS も描画をブロックしない", async ({ request }) => {
    const html = (await (await request.get("/")).text()).replace(/<noscript>[\s\S]*?<\/noscript>/g, "");
    expect(html).toContain('data-testid="skeleton"');
    expect(html).not.toContain("compose-input"); // 下の入力欄は廃止
    const scripts = [...html.matchAll(/<script\b[^>]*src=[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(s).toContain('type="module"');
    const sheets = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)].map((m) => m[0]);
    for (const l of sheets) expect(l).toContain('media="print"');
  });

  test("＋は右下（タブの「完了」の上）にある丸いボタン", async ({ page }) => {
    await login(page);
    await page.goto("/");
    await ready(page);
    const fab = (await page.getByTestId("add").boundingBox())!;
    const done = (await page.getByTestId("tab-done").boundingBox())!;
    expect(Math.abs(fab.width - fab.height)).toBeLessThan(1);
    expect(fab.y + fab.height).toBeLessThan(done.y); // 完了タブより上
    expect(fab.x + fab.width / 2).toBeGreaterThan(done.x); // 完了タブの列
    const radius = await page.getByTestId("add").evaluate((el) => getComputedStyle(el).borderRadius);
    expect(radius).toBe("50%");
  });

  test("状態・期限・やること・メモを選んで追加できる", async ({ page }) => {
    await login(page);
    await page.goto("/");
    await ready(page);
    await page.getByTestId("add").tap();
    const sheet = page.getByTestId("new-sheet");
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId("new-title")).toBeFocused();
    await sheet.getByRole("radio", { name: "進行中" }).tap();
    await sheet.getByRole("radio", { name: "明日" }).tap();
    await page.getByTestId("new-title").fill("企業研究をする");
    await page.getByTestId("new-note").fill("面接の前に");
    await page.getByTestId("new-add").tap();
    await expect(sheet).toHaveCount(0);
    // 進行中で追加したので、進行中タブに切り替わって表示される
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("進行中");
    await expect(card(page, "企業研究をする").getByTestId("due")).toHaveText("明日");
    await expect
      .poll(async () => (await serverTasks(page))[0])
      .toMatchObject({ title: "企業研究をする", status: "doing", due_date: isoDate(1), note: "面接の前に" });
  });

  test("期限を選んだときは、打った文をそのまま使う（AI で書き換えない）", async ({ page }) => {
    await login(page);
    await page.goto("/");
    await ready(page);
    await page.getByTestId("add").tap();
    await page.getByTestId("new-sheet").getByRole("radio", { name: "来週" }).tap();
    await page.getByTestId("new-title").fill("明日までに資料作成");
    await page.getByTestId("new-title").press("Enter");
    await page.waitForTimeout(800);
    await expect(card(page, "明日までに資料作成")).toBeVisible();
    await expect.poll(async () => (await serverTasks(page))[0]).toMatchObject({ title: "明日までに資料作成", due_date: isoDate(7) });
  });

  test("やることが空のときは追加できない。閉じても何も増えない", async ({ page }) => {
    await login(page);
    await page.goto("/");
    await ready(page);
    await page.getByTestId("add").tap();
    await expect(page.getByTestId("new-add")).toBeDisabled();
    await page.getByTestId("new-title").fill("   ");
    await expect(page.getByTestId("new-add")).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("new-sheet")).toHaveCount(0);
    await expect(page.getByTestId("count-todo")).toHaveText("0");
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

  test("PC では N キーで追加シートが開き、そのまま打てる", async ({ browser }) => {
    const ctx = await browser.newContext({ ...devices["Desktop Chrome"], baseURL: ORIGIN, serviceWorkers: "block" });
    const page = await ctx.newPage();
    await login(page);
    await page.goto("/");
    await ready(page);
    await page.keyboard.press("n");
    await expect(page.getByTestId("new-title")).toBeFocused();
    await page.keyboard.type("キーボードで追加");
    await page.keyboard.press("Enter");
    await expect(card(page, "キーボードで追加")).toBeVisible();
    await ctx.close();
  });

  test("前の版で JS 読み込み前に打ったメモが端末に残っていれば取り込む", async ({ page }) => {
    await login(page);
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("seeded")) {
        localStorage.setItem("flick:boot-queue", JSON.stringify([{ text: "前の版のメモ", at: Date.now() }]));
        sessionStorage.setItem("seeded", "1");
      }
    });
    await page.goto("/");
    await ready(page);
    await expect(card(page, "前の版のメモ")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("flick:boot-queue"))).toBeNull();
  });
});

/* ================= スケルトン ================= */

test("全画面スケルトンがデータ取得まで表示され、終わると＋ボタンが使える", async ({ page }) => {
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
  await expect(sk.locator(".sk-fab")).toBeVisible();
  release();
  await ready(page);
  await addMemo(page, "読み込み後のメモ");
  await expect(card(page, "読み込み後のメモ")).toBeVisible();
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

test("詳細シートの「完了」ボタンで完了にでき、完了済みなら未着手に戻せる", async ({ page }) => {
  await login(page);
  await page.goto("/");
  await ready(page);
  await addMemo(page, "ボタンで完了");
  await card(page, "ボタンで完了").locator(".card-title").tap();
  await expect(page.getByTestId("breakdown")).toHaveCount(0); // 「AIで分解」は廃止
  await expect(page.getByTestId("complete")).toHaveText("完了");
  await page.getByTestId("complete").tap();
  await expect(page.getByTestId("sheet")).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText("完了にしました");
  await expect(page.getByTestId("count-done")).toHaveText("1");
  await expect.poll(async () => (await serverTasks(page))[0]?.status).toBe("done");
  await page.getByTestId("tab-done").tap();
  await card(page, "ボタンで完了").locator(".card-title").tap();
  await expect(page.getByTestId("complete")).toHaveText("未着手に戻す");
  await page.getByTestId("complete").tap();
  await expect(page.getByTestId("count-todo")).toHaveText("1");
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

  test("状況を書くと AI がタスクに分け、確かめてから追加できる", async ({ page }) => {
    await page.getByTestId("ai-open").tap();
    const sheet = page.getByTestId("ai-sheet");
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId("ai-plan")).toBeDisabled();
    await page.getByTestId("ai-text").fill("明日までに発表資料を作る。レポートを書いている途中。部屋の掃除");
    await page.getByTestId("ai-plan").tap();
    const items = page.getByTestId("plan-item");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0).getByTestId("plan-title")).toHaveValue("発表資料を作る");
    await expect(items.nth(0)).toContainText("明日");
    await expect(items.nth(1)).toContainText("進行中");
    // 3件目は外し、2件目の名前を直してから追加
    await items.nth(2).getByRole("checkbox").uncheck();
    await items.nth(1).getByTestId("plan-title").fill("レポートを書く");
    await expect(page.getByTestId("ai-add")).toHaveText("2件を追加");
    await expect(page.getByTestId("count-todo")).toHaveText("0"); // 押すまでは追加されない
    await page.getByTestId("ai-add").tap();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByTestId("toast")).toContainText("2件追加しました");
    await expect(page.getByTestId("count-todo")).toHaveText("1");
    await expect(page.getByTestId("count-doing")).toHaveText("1");
    await expect.poll(async () => (await serverTasks(page)).map((t) => [t.title, t.status, t.due_date]).sort()).toEqual(
      [["レポートを書く", "doing", null], ["発表資料を作る", "todo", isoDate(1)]].sort(),
    );
    await expect(card(page, "部屋の掃除")).toHaveCount(0);
  });

  test("マイクで話すと Whisper で文字になり、そのままタスクにできる", async ({ page }) => {
    await page.getByTestId("ai-open").tap();
    await page.getByTestId("mic").tap();
    await expect(page.getByTestId("ai-status")).toContainText("聞いています");
    await page.waitForTimeout(1200);
    await page.getByTestId("mic").tap();
    await expect(page.getByTestId("ai-text")).toHaveValue("明日までに発表資料を作る。レポートを書いている途中");
    await page.getByTestId("ai-plan").tap();
    await expect(page.getByTestId("plan-item")).toHaveCount(2);
    await page.getByTestId("ai-back").tap(); // 言い直すと文章が残っている
    await expect(page.getByTestId("ai-text")).toHaveValue("明日までに発表資料を作る。レポートを書いている途中");
  });

  test("AI が元の文に無い漢字を書いたら「字を確認」の目印が出る", async ({ page }) => {
    await page.route("**/api/ai/plan", (route) =>
      route.fulfill({ json: { tasks: [{ title: "AIHPチラシを棗了る", due_date: null, status: "todo", note: "" }, { title: "チラシを仕上げる", due_date: null, status: "todo", note: "" }] } }),
    );
    await page.getByTestId("ai-open").tap();
    await page.getByTestId("ai-text").fill("AIHPのチラシを仕上げる");
    await page.getByTestId("ai-plan").tap();
    const items = page.getByTestId("plan-item");
    await expect(items.nth(0).getByTestId("plan-warn")).toContainText("棗了");
    await expect(items.nth(1).getByTestId("plan-warn")).toHaveCount(0);
  });

  test("AI に接続できなくても、書いた文は消えない", async ({ page }) => {
    await page.route("**/api/ai/plan", (route) => route.fulfill({ status: 502, json: { error: "ai_failed" } }));
    await page.getByTestId("ai-open").tap();
    await page.getByTestId("ai-text").fill("消えてほしくない文");
    await page.getByTestId("ai-plan").tap();
    await expect(page.getByTestId("ai-status")).toContainText("AIに接続できませんでした");
    await expect(page.getByTestId("ai-text")).toHaveValue("消えてほしくない文");
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
  await expect(page.getByTestId("ai-open")).toBeDisabled(); // AI は通信が必要
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
    await expect(page.getByTestId("add")).toHaveCount(0);
    await expect(page.getByTestId("ai-open")).toHaveCount(0);
    // 本文の見えている文字はこれだけ
    const visible = (await page.locator("main").innerText()).replace(/\s+/g, " ").trim();
    expect(visible).toBe("Flick Googleでログイン");
  });

  test("Google ボタンで Google の認可画面へ（PKCE + state 付き）", async ({ page }) => {
    // 最初に出た認可リクエストだけを記録する（リダイレクト経由でも request イベントは必ず発火する）。
    // Google 側の後続の通信（エラー報告など）で上書きされないようにする
    let authUrl = "";
    page.on("request", (req) => {
      if (!authUrl && req.url().includes("accounts.google.com/o/oauth2/v2/auth")) authUrl = req.url();
    });
    await page.context().route("https://accounts.google.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<title>google</title>" }),
    );
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
    // ログイン確認は本文を読む前に行う。ローカルのテストサーバー（Miniflare）は、本文を読まずに返すと
    // まれに接続が切れて 500 になるため、ここでは本文なしで送る
    expect((await anon.post("/api/ai/plan", { headers: { origin: ORIGIN } })).status()).toBe(401);
    expect((await anon.post("/api/ai/transcribe", { headers: { origin: ORIGIN } })).status()).toBe(401);
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
  test("ガラスは操作レイヤー（タブ・AIボタン・シート）だけで、カードは不透明", async ({ page }) => {
    await login(page);
    await page.goto("/");
    await ready(page);
    await addMemo(page, "ガラス確認");
    const bf = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backdropFilter);
    expect(await bf(".fab-ai")).toContain("blur");
    expect(await bf(".tabs")).toContain("blur");
    expect(await bf(".card")).toBe("none");
    const bg = await page.locator(".card").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgb(255, 255, 255)");
  });

  test("「透明度を下げる」設定ではガラスを不透明にする", async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(await page.locator(".sk-tabs").evaluate((el) => getComputedStyle(el).backdropFilter)).toBe("none");
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
