import { defineConfig, type Plugin } from "vite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Monaco Editor 的 ESM 版本只内置英文：nls.localize(key, "English text")。
// 官方中文语言包是「下标 → 中文」数组，与本版本 dev 构建的「下标 → 英文」调用一一对应，
// 已离线整理成「英文原文 → 中文」表。构建时把它注入 nls.js 的格式化入口，
// 命中即显示中文，未命中仍回退英文，不影响功能。
const zhCN = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "src/monaco.zh-cn.json"), "utf8");

function monacoZhCN(): Plugin {
  return {
    name: "monaco-editor-zh-cn",
    enforce: "pre",
    transform(code, id) {
      const file = id.replace(/\\/g, "/");
      if (!file.includes("/monaco-editor/esm/vs/nls.js")) return;
      const target = "function _format(message, args) {";
      if (!code.includes(target)) {
        throw new Error("Monaco 中文化失败：未找到 nls.js 的 _format，请检查 monaco-editor 版本与词条表是否匹配");
      }
      const patched = code.replace(target, () =>
        `const __MONACO_ZH_CN__ = ${zhCN};\n` +
        `function _format(message, args) {\n    message = __MONACO_ZH_CN__[message] ?? message;`
      );
      return { code: patched, map: null };
    },
  };
}

export default defineConfig({
  clearScreen: false,
  plugins: [monacoZhCN()],
  // 预构建由 esbuild 完成，会绕过上面的 transform 钩子；排除后 dev / build 均生效。
  optimizeDeps: { exclude: ["monaco-editor"] },
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: "es2022" },
});
