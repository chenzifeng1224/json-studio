# JSON Studio — Tauri 2

一个面向本地 JSON 和 AWS S3 JSON 对象的桌面编辑器。

## 功能

- Monaco Editor：JSON 语法高亮、实时语法诊断、括号匹配与括号对颜色提示、默认自动换行。
- 底部“问题诊断”面板：收集 Monaco 诊断标记，显示错误/警告数量、类型、行列位置与中文说明；点击条目或按 `F8` / `Shift+F8` 精准跳转，行号区同步显示错误标记。
- 当前括号匹配使用高亮背景 + 黄色描边，并在编辑器光标位于括号附近时突出显示配对括号。
- JSON 格式化（2 空格缩进）、压缩。
- 指定对象/数组路径压缩为单行：支持 `data.items`、`$.data.items`、`items[0]` 等路径。
- 顶部“云端 / 本地”双模式切换，左侧文件树随模式切换。
- 云端模式：按已配置的 S3 区域、Bucket、Prefix 按层级懒加载目录（仅列对象元数据，不下载文件内容），展开文件夹时才请求下一层；点击 JSON 文件才下载内容进入编辑器。
- 云端搜索：按文件名或文件夹名模糊匹配；范围可选“同级（默认，只列当前层，几乎一次请求完成，命中的文件夹可直接展开继续浏览）”或“全层级（扫描整桶对象列表，仅元数据，首次结果缓存 5 分钟）”，最多返回 500 条匹配。
- 本地模式：选择本地文件夹后递归展示父级文件夹、子层级和 JSON 文件，可直接点击树节点打开；跳过 `node_modules`、`target`、`.git` 与符号链接，最多扫描 10000 个 JSON 文件。
- 文件树中文件夹名使用灰色，JSON 文件名使用蓝色；当前打开的文件高亮显示。
- 滚动条统一使用界面深色配色（侧栏、文件树、弹窗、诊断面板与编辑器一致）。
- S3 配置收进“配置”按钮打开的模态弹窗，不再常驻左侧面板。
- 本地 `.json` 文件打开、保存。
- S3 国际区 / 中国区配置；仅列出 `.json` 对象；下载编辑；严格校验后覆盖上传至原 key。
- Access Key / Secret Key 存入操作系统凭据库（Windows Credential Manager、macOS Keychain、Linux Secret Service），不写入项目配置文件。
- S3 区域、Bucket、Prefix 持久化到应用配置目录；Access Key / Secret Key 按区域分别保存在操作系统凭据库。重启后会自动恢复区域、Bucket 和 Prefix，密钥不会回填到输入框，但可直接使用已保存凭据访问。

## S3 内置配置

| 区域 | Region | Bucket | Endpoint |
|---|---|---|---|
| 国际 | `us-east-1` | `hellofairyapp` | AWS 默认 |
| 中国 | `cn-north-1` | `hellofairyfile` / `hellofairyapp` | `https://s3.cn-north-1.amazonaws.com.cn` |

公开 URL 常量也保留在 `src-tauri/src/main.rs` 中，仅作为配置参考；本工具通过 AWS SDK 鉴权 API 访问私有对象，不依赖 Public URL。

## 环境要求

- Node.js 20+
- Rust stable（建议 rustup 安装）
- Tauri 2 所需系统依赖：https://v2.tauri.app/start/prerequisites/
- 本地禁止安装环境，云端构建与编译

## 开发运行

```bash
npm install
npm run tauri dev
```

## 使用说明

1. 打开本地 JSON，或在左侧 S3 面板选择区域。
2. 填入对应区域的 Access Key / Secret Key，选择 Bucket，输入可选 Prefix。
3. 点击“保存配置”，再点击“拉取 JSON 列表”。
4. 点击对象名载入编辑；点击“推送覆盖”保存到相同 Bucket + Key。
5. 推送前前端与 Rust 后端都会校验 JSON；非 `.json` 对象无法读取或写入。

## 安全说明

- 凭据通过 OS 原生凭据库保存。请勿把密钥硬编码进源码或提交到 Git。
- S3 IAM 用户建议仅授予目标 Bucket / Prefix 所需的 `s3:ListBucket`、`s3:GetObject`、`s3:PutObject` 权限。
- 覆盖上传不可自动撤销，建议先开启 S3 Versioning 或在推送前下载备份。
- Linux 需要可用的 Secret Service（如 GNOME Keyring）；否则系统凭据保存会失败。
- 中国区与国际区凭据独立保存，不会混用。

## 当前版本说明 / 后续可增强

- 当前“指定路径压缩”使用格式化后节点文本定位；当相同 JSON 子树在文件中重复出现时，会提示定位失败或可能命中首个匹配。建议后续升级为基于 Monaco AST/token offset 的节点范围编辑。
- JSON 语法诊断以 Monaco JSON 语言服务产生的 marker 为唯一数据源，不使用正则判断 JSON 是否合法；格式化、压缩与推送前仍用 `JSON.parse` / `serde_json` 取值并作为最后防线。不接受注释、尾逗号、NaN、Infinity。
- 为避免意外数据损坏，上传操作始终校验 JSON；当前不提供删除对象或批量上传功能。

## 界面语言

- 全部界面、状态提示与错误信息为简体中文。品牌名 `JSON Studio` 与技术专名（S3 / Bucket / Prefix / Access Key）按惯例保留，标签中附中文说明。
- Monaco Editor 内置菜单、查找替换、命令面板等文案由 `vite.config.ts` 的 `monacoZhCN()` 插件在构建时注入，词条表为 `src/monaco.zh-cn.json`（取自 monaco-editor 0.52.2 官方 zh-cn 语言包，1279 条「英文 → 中文」映射）。`optimizeDeps.exclude: ["monaco-editor"]` 用于跳过 esbuild 预构建，保证开发模式同样生效。未命中的词条回退英文，不影响功能。
- 升级 monaco-editor 后需重新生成词条表：取同版本 `dev/vs/editor/editor.main.js` 中的 `localize(下标, "英文")` 与 `dev/vs/nls.messages.zh-cn.js` 的「下标 → 中文」数组建立映射。插件找不到 `nls.js` 的 `_format` 时会直接让构建报错，避免静默退回英文。
- `src/main.ts` 的 `zhError()` 负责文件 / 网络 / 后端错误的兜底翻译；Monaco 诊断优先按 marker code 映射中文，code 缺失时才用关键词兜底，并保留英文原文作为技术详情。Rust 后端 `map_err` 统一使用中文说明，SDK 原始错误作为括号内的详情保留。

## 云端构建（本地零依赖）

本地只维护源码，**不安装依赖、不执行构建、不打包**；所有依赖安装、类型检查、前端打包和 Tauri 打包均由 GitHub Actions 完成。

- 工作流：`.github/workflows/build-windows.yml`，使用 `windows-latest`（自带 Node、Rust、WebView2）。
- 触发：推送 `main`、`v*` 标签，或在 Actions 页手动运行。
- 步骤：`npm install` → `npm run build`（tsc + vite）→ `npm run tauri build` → NSIS `.exe` 安装包上传为 Actions 制品；打 `v*` 标签时额外生成草稿 Release。
- 首次云端构建需要编译 AWS SDK 等 Rust 依赖，耗时较长属正常；`swatinem/rust-cache` 会缓存后续构建。
- 仓库需开启 Actions 的读写权限（Settings → Actions → Workflow permissions → Read and write permissions），否则草稿 Release 可能发布失败。
