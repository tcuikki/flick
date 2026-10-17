import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import type { Plugin } from "vite";

/** バンドル CSS を描画ブロックしない読み込みにする（初回描画はインラインのクリティカル CSS で行う） */
const asyncCss = (): Plugin => ({
  name: "flick-async-css",
  apply: "build",
  transformIndexHtml: {
    order: "post",
    handler: (html) =>
      html.replace(/<link rel="stylesheet"([^>]*?)>/g, (_m, attrs) =>
        `<link rel="stylesheet"${attrs} media="print" onload="this.media='all'"><noscript><link rel="stylesheet"${attrs}></noscript>`,
      ),
  },
});

export default defineConfig({
  plugins: [react(), cloudflare(), asyncCss()],
  build: {
    target: "safari16",
    cssCodeSplit: false,
  },
});
