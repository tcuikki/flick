/**
 * 触覚フィードバック。
 * Android/Chrome は Vibration API、iOS Safari 18+ は <input type="checkbox" switch>
 * をトグルするとシステムの触覚が鳴る挙動を使う（未対応環境では何も起きない）。
 */
let label: HTMLLabelElement | null = null;

function iosSwitch() {
  if (!label) {
    label = document.createElement("label");
    label.setAttribute("aria-hidden", "true");
    label.style.cssText = "position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;left:-9px;top:0";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");
    input.tabIndex = -1;
    label.appendChild(input);
    document.body.appendChild(label);
  }
  label.click();
}

export function haptic(kind: "light" | "medium" | "success" = "light") {
  try {
    if (typeof navigator.vibrate === "function") {
      navigator.vibrate(kind === "success" ? [12, 40, 18] : kind === "medium" ? 16 : 8);
    } else {
      iosSwitch();
    }
  } catch {
    /* noop */
  }
}
