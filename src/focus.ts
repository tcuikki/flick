/**
 * iOS Safari は「タップの処理中に」入力欄へフォーカスしないとキーボードを開かない。
 * シートはタップの後に描画されるので、タップの時点で見えない入力欄に先にフォーカスしておき、
 * シートの入力欄が出たらそちらへフォーカスを移す（キーボードは開いたまま引き継がれる）。
 */
export function primeKeyboard() {
  let el = document.getElementById("kb-proxy") as HTMLInputElement | null;
  if (!el) {
    el = document.createElement("input");
    el.id = "kb-proxy";
    el.setAttribute("aria-hidden", "true");
    el.tabIndex = -1;
    el.style.cssText = "position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;font-size:16px;border:0;padding:0;pointer-events:none;";
    document.body.appendChild(el);
  }
  try { el.focus({ preventScroll: true }); } catch { /* noop */ }
}

/**
 * iPhone ではキーボードが画面の上に重なるだけで、画面の高さは変わらない。
 * キーボードを除いた「実際に見えている高さ」を --vvh に入れておき、上から出るシートの最大の高さに使う。
 */
export function trackVisibleHeight() {
  const vv = window.visualViewport;
  const set = () => document.documentElement.style.setProperty("--vvh", `${Math.round(vv ? vv.height : window.innerHeight)}px`);
  set();
  vv?.addEventListener("resize", set);
  window.addEventListener("resize", set);
}
