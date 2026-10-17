import { createRoot } from "react-dom/client";
import { App } from "./App";
import { boot } from "./store";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
void boot();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
