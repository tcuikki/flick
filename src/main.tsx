import { createRoot } from "react-dom/client";
import { App } from "./App";
import { boot } from "./store";
import { trackVisibleHeight } from "./focus";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
void boot();
trackVisibleHeight();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
