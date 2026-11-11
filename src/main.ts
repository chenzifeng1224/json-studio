import './style.css';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';

(self as any).MonacoEnvironment = { getWorker(_: string, label: string) { return label === 'json' ? new jsonWorker() : new editorWorker(); } };

type Region = 'global' | 'china';
type AppMode = 'cloud' | 'local';
const MODE_STORAGE_KEY = 'json-studio:mode';
type S3Config = { region: Region; bucket: string; prefix: string; accessKey: string; secretKey: string };
type LocalJsonEntry = { relative: string; absolute: string };
type TreeNode = {
  name: string;
  displayPath: string;
  fullPath: string;
  kind: 'folder' | 'file';
  children: TreeNode[];
  expanded: boolean;
  // 云端目录按需加载：remote 表示需要展开时再向后端取一层，loaded 标记该层已取回。
  remote?: boolean;
  loaded?: boolean;
  loading?: boolean;
};
let editor: monaco.editor.IStandaloneCodeEditor;
let currentFile: string | null = null;
let currentObjectKey: string | null = null;
// 每个模式各自缓存已打开文档，切换 Tab 时编辑区随之切换；未选择文件则显示空文档。
type FileDoc = { ref: string; title: string; text: string; tag: string };
let cloudDoc: FileDoc | null = null;
let localDoc: FileDoc | null = null;
let compactPaths: string[] = [];
let currentRegion: Region = 'global';
let currentBucket = '';
let currentPrefix = '';
let mode: AppMode = 'cloud';
let cloudTreeRoot: TreeNode | null = null;
let localTreeRoot: TreeNode | null = null;
let localRootPath: string | null = null;
let localRootName = '';
let cloudLoading = false;
let localLoading = false;
let cloudTreeNotice = '';
let localTreeNotice = '';
let configReturnFocus: HTMLElement | null = null;
let cloudSearchQuery = '';
let cloudSearchRoots: TreeNode[] | null = null;
let cloudSearching = false;
let cloudSearchNotice = '';
let cloudSearchInfo = '';
let cloudSearchTimer = 0;
let cloudSearchSeq = 0;
type SearchScope = 'level' | 'deep';
let cloudSearchScope: SearchScope = 'level';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (message: string, kind = '') => { $('status').textContent = message; $('status').className = `status ${kind}`; };
const setDirty = () => $('dirty').textContent = currentFile || currentObjectKey ? '● 已载入' : '● 未命名';
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;

function countFiles(node: TreeNode | null): number {
  if (!node) return 0;
  if (node.kind === 'file') return 1;
  return node.children.reduce((sum, child) => sum + countFiles(child), 0);
}

function buildTree(entries: { displayPath: string; fullPath: string }[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const folders = new Map<string, TreeNode>();
  const files = new Set<string>();

  for (const entry of entries) {
    const parts = entry.displayPath.split('/').filter(Boolean);
    if (!parts.length) continue;
    let children = roots;
    let prefix = '';
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index];
      prefix = prefix ? `${prefix}/${name}` : name;
      if (index === parts.length - 1) {
        if (files.has(prefix)) continue;
        files.add(prefix);
        children.push({ name, displayPath: prefix, fullPath: entry.fullPath, kind: 'file', children: [], expanded: false });
      } else {
        let folder = folders.get(prefix);
        if (!folder) {
          folder = { name, displayPath: prefix, fullPath: prefix, kind: 'folder', children: [], expanded: true };
          folders.set(prefix, folder);
          children.push(folder);
        }
        children = folder.children;
      }
    }
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.kind === b.kind
      ? a.name.localeCompare(b.name, 'zh-CN')
      : (a.kind === 'folder' ? -1 : 1));
    nodes.forEach(node => sortNodes(node.children));
  };
  sortNodes(roots);
  return roots;
}

function treeContainer(target: AppMode): HTMLElement {
  return $(target === 'cloud' ? 'cloudTree' : 'localTree');
}

function setTreeMessage(target: AppMode, text: string, kind = '') {
  const container = treeContainer(target);
  container.textContent = '';
  const element = document.createElement('div');
  element.className = kind ? `empty ${kind}` : 'empty';
  element.textContent = text;
  container.append(element);
}

function updateCloudContext() {
  const context = $('cloudContext');
  context.classList.toggle('error', !currentBucket);
  if (!currentBucket) { context.textContent = '未配置 S3'; return; }
  const label = currentBucket;
  if (cloudSearchQuery) {
    context.textContent = cloudSearching ? '正在全桶搜索…' : (cloudSearchInfo || `搜索：${cloudSearchQuery}`);
    return;
  }
  const count = countFiles(cloudTreeRoot);
  context.textContent = cloudLoading ? '正在读取云端目录…' : (count ? `${label} · 已加载 ${count} 个 JSON` : label);
}

function updateLocalContext() {
  const count = countFiles(localTreeRoot);
  const context = $('localContext');
  context.textContent = localLoading ? '正在扫描…' : (localRootName ? `${localRootName}${count ? ` · ${count} 个 JSON` : ''}` : '未选择文件夹');
  context.classList.toggle('error', false);
}

function updateTreeContext() {
  updateCloudContext();
  updateLocalContext();
}

function isTreeFileActive(node: TreeNode): boolean {
  if (node.kind !== 'file') return false;
  return mode === 'cloud' ? node.fullPath === currentObjectKey : node.fullPath === currentFile;
}

function renderTreeNode(container: HTMLElement, node: TreeNode, depth: number) {
  const isFolder = node.kind === 'folder';
  const row = document.createElement('button');
  row.type = 'button';
  row.className = `tree-row ${node.kind}${depth === 0 ? ' is-root' : ''}`;
  row.style.paddingLeft = `${8 + depth * 14}px`;
  row.title = node.fullPath || node.displayPath || node.name;
  if (!isFolder && isTreeFileActive(node)) row.classList.add('active');
  if (isFolder) row.setAttribute('aria-expanded', String(node.expanded));

  const marker = document.createElement('span');
  marker.className = isFolder ? 'tree-chevron' : 'tree-file-dot';
  marker.textContent = isFolder ? (node.expanded ? '▾' : '▸') : '•';
  marker.setAttribute('aria-hidden', 'true');

  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = node.name;
  row.append(marker, name);

  row.addEventListener('click', () => {
    if (isFolder) void toggleFolder(node);
    else void openTreeFile(node);
  });
  container.append(row);

  if (!isFolder || !node.expanded) return;
  if (node.remote && !node.loaded) {
    const pending = document.createElement('div');
    pending.className = node.loading ? 'tree-empty pending' : 'tree-empty';
    pending.style.paddingLeft = `${8 + (depth + 1) * 14}px`;
    pending.textContent = node.loading ? '加载中…' : '展开后加载';
    container.append(pending);
    return;
  }
  if (!node.children.length) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.style.paddingLeft = `${8 + (depth + 1) * 14}px`;
    empty.textContent = '没有 JSON 文件';
    container.append(empty);
    return;
  }
  node.children.forEach(child => renderTreeNode(container, child, depth + 1));
}

function renderTree() {
  if (mode === 'local' && localLoading && !localTreeRoot) {
    setTreeMessage('local', '正在扫描本地 JSON…', 'pending');
    updateTreeContext();
    return;
  }

  const container = treeContainer(mode);
  container.textContent = '';

  if (mode === 'cloud') {
    if (!currentBucket) {
      setTreeMessage('cloud', '尚未配置 S3，点击“配置”填写存储桶与密钥');
      updateTreeContext();
      return;
    }
    if (cloudSearchQuery) {
      if (cloudSearching) {
        setTreeMessage('cloud', '正在全桶搜索，请稍候…', 'pending');
      } else if (cloudSearchNotice) {
        setTreeMessage('cloud', cloudSearchNotice, 'error');
      } else if (!cloudSearchRoots || !cloudSearchRoots.length) {
        setTreeMessage('cloud', '没有匹配的 JSON 文件');
      } else {
        cloudSearchRoots.forEach(node => renderTreeNode(container, node, 0));
      }
      updateTreeContext();
      return;
    }
    const root = cloudTreeRoot;
    if (!root) {
      setTreeMessage('cloud', cloudTreeNotice || '点击“刷新”读取云端目录');
      updateTreeContext();
      return;
    }
    if (!root.loaded) {
      if (cloudTreeNotice) setTreeMessage('cloud', cloudTreeNotice, 'error');
      else setTreeMessage('cloud', root.loading ? '正在读取云端目录…' : '点击“刷新”读取云端目录', root.loading ? 'pending' : '');
      updateTreeContext();
      return;
    }
    renderTreeNode(container, root, 0);
    updateTreeContext();
    return;
  }

  const root = localTreeRoot;
  if (!root) {
    const notice = localTreeNotice;
    const fallback = localRootPath ? '点击“刷新”重新扫描' : '点击“打开文件夹”选择目录';
    setTreeMessage('local', notice || fallback, notice ? 'error' : '');
    updateTreeContext();
    return;
  }
  renderTreeNode(container, root, 0);
  updateTreeContext();
}

function highlightActiveTreeRow() {
  treeContainer(mode).querySelector<HTMLElement>('.tree-row.active')?.scrollIntoView({ block: 'nearest' });
}

// 浏览器 JSON.parse 报错、Monaco JSON 诊断、AWS SDK / 系统底层错误均为英文。
// 按关键词确定性映射为中文；未命中的保留英文原文作为技术详情，避免丢失排错信息。
const ZH_ERROR_RULES: [RegExp, string][] = [
  [/Property keys must be doublequoted/i, '属性名必须使用双引号'],
  [/Property name expected|Expected property name/i, '此处应为属性名'],
  [/Colon expected|Expected colon/i, '属性名后缺少冒号'],
  [/Comma expected|Expected comma/i, '此处缺少逗号，或存在多余内容'],
  [/Trailing comma/i, '存在不允许的尾逗号'],
  [/Comments? are not permitted|Comment not allowed/i, 'JSON 中不允许写注释'],
  [/Unexpected end of (?:JSON input|file|string)/i, '内容不完整，缺少结束符号'],
  [/End of file expected/i, '结束符之后存在多余内容'],
  [/Value expected/i, '此处缺少值'],
  [/Invalid number|Number expected/i, '数字格式不正确'],
  [/Unterminated string|String expected/i, '字符串未正确闭合'],
  [/Duplicate (?:object )?key/i, '存在重复的属性名'],
  [/Unexpected token|Unexpected character|Invalid token/i, '出现无法识别的字符或符号'],
  [/No such file or directory|ENOENT/i, '文件不存在'],
  [/Permission denied|Access is denied|AccessDenied/i, '没有访问权限，请检查密钥或文件权限'],
  [/InvalidAccessKeyId/i, '访问密钥 ID 无效'],
  [/SignatureDoesNotMatch/i, '密钥签名不匹配，请检查私有访问密钥'],
  [/NoSuchBucket/i, '存储桶不存在'],
  [/NoSuchKey/i, '云端文件不存在'],
  [/RequestTimeout|timed out|timeout/i, '请求超时，请稍后重试'],
  [/connection refused|network|dns|socket/i, '网络连接失败，请检查网络'],
];
const translateError = (raw: string) => ZH_ERROR_RULES.find(([re]) => re.test(raw))?.[1] || '';
// 仅用于文件 / 网络 / 后端错误的兜底翻译，不参与 JSON 语法定位。
const zhError = (e: unknown, prefix = '操作失败') => {
  const raw = String(e ?? '').replace(/^Error:\s*/i, '').trim();
  if (!raw) return `${prefix}：未知错误`;
  const translated = translateError(raw);
  if (translated) return `${prefix}：${translated}`;
  // 后端已返回中文说明时直接使用；纯英文错误补中文说明，原文附后便于排查。
  return /[\u4e00-\u9fa5]/.test(raw) ? raw : `${prefix}：${raw}`;
};
// Monaco JSON worker 的错误码映射（对应 jsonc-parser 的 ParseErrorCode）。
// 优先按 code 翻译，避免依赖随版本变化的英文文案；code 缺失时才回退到关键词匹配。
const JSON_ERROR_MESSAGES: Record<string, string> = {
  '1': '出现无法识别的符号',
  '2': '数字格式不正确',
  '3': '属性名必须使用双引号',
  '4': '此处缺少值',
  '5': '属性名后缺少冒号',
  '6': '此处缺少逗号',
  '7': '缺少右花括号 }',
  '8': '缺少右方括号 ]',
  '9': '结束符之后存在多余内容',
  '10': 'JSON 中不允许写注释',
  '11': '注释未正确闭合',
  '12': '字符串未正确闭合',
  '13': '数字未正确结束',
  '14': 'Unicode 转义格式不正确',
  '15': '转义字符不正确',
  '16': '出现无法识别的字符',
  InvalidSymbol: '出现无法识别的符号',
  InvalidNumberFormat: '数字格式不正确',
  PropertyNameExpected: '属性名必须使用双引号',
  ValueExpected: '此处缺少值',
  ColonExpected: '属性名后缺少冒号',
  CommaExpected: '此处缺少逗号',
  CloseBraceExpected: '缺少右花括号 }',
  CloseBracketExpected: '缺少右方括号 ]',
  EndOfFileExpected: '结束符之后存在多余内容',
  InvalidCommentToken: 'JSON 中不允许写注释',
  UnexpectedEndOfComment: '注释未正确闭合',
  UnexpectedEndOfString: '字符串未正确闭合',
  UnexpectedEndOfNumber: '数字未正确结束',
  InvalidUnicode: 'Unicode 转义格式不正确',
  InvalidEscapeCharacter: '转义字符不正确',
  InvalidCharacter: '出现无法识别的字符',
};
const JSON_ERROR_HINTS: Record<string, string> = {
  '3': '属性名必须使用双引号包裹',
  '4': '冒号或逗号后缺少值',
  '5': '属性名后必须使用冒号',
  '6': '对象属性或数组元素之间必须用逗号分隔',
  '7': '对象缺少结束的右花括号',
  '8': '数组缺少结束的右方括号',
  '12': '字符串缺少结束引号',
  PropertyNameExpected: '属性名必须使用双引号包裹',
  ValueExpected: '冒号或逗号后缺少值',
  ColonExpected: '属性名后必须使用冒号',
  CommaExpected: '对象属性或数组元素之间必须用逗号分隔',
  CloseBraceExpected: '对象缺少结束的右花括号',
  CloseBracketExpected: '数组缺少结束的右方括号',
  UnexpectedEndOfString: '字符串缺少结束引号',
};

type DiagnosticKind = '语法' | '结构' | '业务' | '校验';
type DiagnosticView = {
  marker: monaco.editor.IMarker;
  message: string;
  raw: string;
  kind: DiagnosticKind;
  severity: 'error' | 'warning';
};

function markerCode(marker: monaco.editor.IMarker): string {
  const code = marker.code as unknown;
  if (typeof code === 'string' || typeof code === 'number') return String(code);
  if (code && typeof code === 'object' && 'value' in code) {
    return String((code as { value: unknown }).value);
  }
  return '';
}

function localizeMarker(marker: monaco.editor.IMarker): string {
  const code = markerCode(marker);
  const translated = JSON_ERROR_MESSAGES[code];
  if (translated) {
    const hint = JSON_ERROR_HINTS[code];
    return hint ? `${translated}（${hint}）` : translated;
  }
  const fallback = translateError(marker.message);
  if (fallback) return fallback;
  return /[\u4e00-\u9fa5]/.test(marker.message) ? marker.message : `语法错误：${marker.message}`;
}

function classifyMarker(marker: monaco.editor.IMarker): DiagnosticKind {
  if (marker.owner === 'json-studio') return '业务';
  if (marker.owner === 'json') return '语法';
  return '校验';
}

monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
  validate: true, allowComments: false, schemas: [], enableSchemaRequest: false,
  comments: 'error', trailingCommas: 'error'
});
// 滚动条沿用界面深色系，避免 Monaco 默认的高亮滑杆与侧栏不一致。
monaco.editor.defineTheme('json-studio-dark', {
  base: 'vs-dark', inherit: true, rules: [],
  colors: {
    'scrollbarSlider.background': '#33404f80',
    'scrollbarSlider.hoverBackground': '#41506ab3',
    'scrollbarSlider.activeBackground': '#4a5f7dcc',
  },
});
editor = monaco.editor.create($('editor'), {
  value: '',
  language: 'json', theme: 'json-studio-dark', automaticLayout: true, minimap: { enabled: true },
  fontSize: 14, tabSize: 2, insertSpaces: true, wordWrap: 'on',
  bracketPairColorization: { enabled: true }, guides: { bracketPairs: true, highlightActiveBracketPair: true },
  matchBrackets: 'always', padding: { top: 14, bottom: 14 }, scrollBeyondLastLine: false
});
editor.onDidChangeModelContent(() => {
  $('dirty').textContent = '● 有未保存修改';
  const doc = currentDoc();
  if (doc) doc.tag = '● 有未保存修改';
});

// Ctrl+F 查找替换面板：为各图标补充中文含义提示（原生 title），并屏蔽 Monaco 自带的英文悬浮提示，避免重复。
const findIconHints: Array<[string, string]> = [
  ['Previous Match', '上一个匹配'],
  ['Next Match', '下一个匹配'],
  ['Close', '关闭查找面板（Esc）'],
  ['Replace All', '替换全部匹配'],
  ['Replace', '替换当前匹配'],
  ['Toggle Replace', '展开 / 收起替换框'],
  ['Match Case', '区分大小写'],
  ['Match Whole Word', '全字匹配'],
  ['Use Regular Expression', '使用正则表达式'],
  ['Preserve Case', '替换时保留原文大小写'],
  ['Find in Selection', '只在选中的文本中查找'],
  ['Toggle Search Scope', '只在选中的文本中查找'],
];
const findIconSelector = '.find-widget [role="button"], .find-widget [role="checkbox"]';
function decorateFindWidget() {
  const editorDom = editor.getDomNode();
  const root = editorDom?.querySelector('.find-widget');
  if (!root) return;
  root.querySelectorAll<HTMLElement>('[role="button"], [role="checkbox"]').forEach((icon) => {
    const label = icon.getAttribute('aria-label') || '';
    const hint = findIconHints.find(([prefix]) => label.startsWith(prefix))?.[1];
    if (hint && icon.getAttribute('title') !== hint) icon.setAttribute('title', hint);
  });
}
{
  const editorDom = editor.getDomNode();
  if (editorDom) {
    const blockHover = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(findIconSelector)) event.stopPropagation();
    };
    editorDom.addEventListener('mouseover', blockHover, true);
    editorDom.addEventListener('mousemove', blockHover, true);
    let scheduled = false;
    const observer = new MutationObserver((mutations) => {
      const touched = mutations.some((mutation) => {
        const element = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        if (element?.closest('.find-widget')) return true;
        return Array.from(mutation.addedNodes).some((node) => node instanceof Element
          && (node.matches('.find-widget') || !!node.querySelector('.find-widget')));
      });
      if (!touched || scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; decorateFindWidget(); });
    });
    observer.observe(editorDom, { childList: true, subtree: true });
  }
}
// 光标位置变化时高亮匹配的两端括号（仅更新装饰，不移动视口、不改变光标）
const bracketDecorations = editor.createDecorationsCollection();
// Monaco 0.52 没有公开 findMatchingBracket，这里用字符串感知的括号配对实现，
// 并按模型版本缓存，避免每次移动光标都重新扫描整篇 JSON。
let bracketPairCache: { versionId: number; pairs: Map<number, number> } | null = null;

function getBracketPairs(model: monaco.editor.ITextModel): Map<number, number> {
  const versionId = model.getVersionId();
  if (bracketPairCache?.versionId === versionId) return bracketPairCache.pairs;

  const text = model.getValue();
  const pairs = new Map<number, number>();
  const stack: { char: string; index: number }[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{' || char === '[') { stack.push({ char, index }); continue; }
    if (char !== '}' && char !== ']') continue;
    const expected = char === '}' ? '{' : '[';
    const top = stack[stack.length - 1];
    if (top?.char !== expected) continue;
    stack.pop();
    pairs.set(top.index, index);
    pairs.set(index, top.index);
  }

  bracketPairCache = { versionId, pairs };
  return pairs;
}

editor.onDidChangeCursorPosition((event) => {
  const model = editor.getModel();
  if (!model) { bracketDecorations.clear(); return; }
  const offset = model.getOffsetAt(event.position);
  const pairs = getBracketPairs(model);
  let matchedRanges: monaco.Range[] | null = null;

  // 光标可能停在括号之后，因此同时检查前一个字符。
  for (const candidate of [offset, offset - 1]) {
    const other = pairs.get(candidate);
    if (other === undefined) continue;
    const start = model.getPositionAt(Math.min(candidate, other));
    const end = model.getPositionAt(Math.max(candidate, other));
    matchedRanges = [
      new monaco.Range(start.lineNumber, start.column, start.lineNumber, start.column + 1),
      new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column + 1),
    ];
    break;
  }

  if (!matchedRanges) { bracketDecorations.clear(); return; }
  bracketDecorations.set(matchedRanges.map((range) => ({
    range,
    options: {
      inlineClassName: 'bracket-pair-strong',
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
    }
  })));
});

// ── 精准诊断 ──────────────────────────────────────────────────────────
// 唯一数据源是 Monaco 的 marker：语法对错、行列位置、波浪线和悬停提示
// 都来自 JSON 语言服务。这里不自行解析 JSON，也不解析 JSON.parse 的报错文本。
const MAX_RENDERED_DIAGNOSTICS = 200;
let diagnostics: DiagnosticView[] = [];
let activeDiagnostic = -1;
let diagnosticsPending = false;
let diagnosticsTimer = 0;
let diagnosticsSignature = '';
const diagnosticDecorations = editor.createDecorationsCollection();

function formatLocation(marker: monaco.editor.IMarker): string {
  return `第 ${marker.startLineNumber} 行，第 ${marker.startColumn} 列`;
}

function collectDiagnostics(): DiagnosticView[] {
  const model = editor.getModel();
  if (!model) return [];
  return monaco.editor.getModelMarkers({ resource: model.uri })
    .filter(marker => marker.severity === monaco.MarkerSeverity.Error || marker.severity === monaco.MarkerSeverity.Warning)
    .sort((a, b) => b.severity - a.severity || a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn)
    .map(marker => ({
      marker,
      message: localizeMarker(marker),
      raw: marker.message,
      kind: classifyMarker(marker),
      severity: marker.severity === monaco.MarkerSeverity.Error ? ('error' as const) : ('warning' as const),
    }));
}

function diagnosticsKey(items: DiagnosticView[]): string {
  return items.map(item => [
    item.marker.severity, item.marker.startLineNumber, item.marker.startColumn,
    item.marker.endLineNumber, item.marker.endColumn, item.marker.owner, item.raw,
  ].join(':')).join('\n');
}

function updateDiagnosticsSummary() {
  const summary = $('diagnosticsSummary');
  if (diagnosticsPending) { summary.textContent = '校验中…'; return; }
  const errors = diagnostics.filter(item => item.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  if (!errors && !warnings) { summary.textContent = '没有问题'; return; }
  const parts: string[] = [];
  if (errors) parts.push(`${errors} 个错误`);
  if (warnings) parts.push(`${warnings} 个警告`);
  summary.textContent = parts.join(' · ');
}

function renderEditorDiagnosticDecorations() {
  if (!editor.getModel()) { diagnosticDecorations.clear(); return; }
  // 同一行有错误时优先显示错误色；行号区只做窄条标记，不额外占用 glyph margin。
  const lines = new Map<number, 'error' | 'warning'>();
  for (const item of diagnostics) {
    const line = item.marker.startLineNumber;
    if (item.severity === 'error' || !lines.has(line)) lines.set(line, item.severity);
  }
  const decorations: monaco.editor.IModelDeltaDecoration[] = [...lines].map(([line, severity]) => ({
    range: new monaco.Range(line, 1, line, 1),
    options: {
      isWholeLine: true,
      linesDecorationsClassName: severity === 'error' ? 'diagnostic-line-error' : 'diagnostic-line-warning',
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  }));
  const active = diagnostics[activeDiagnostic];
  if (active) {
    decorations.push({
      range: new monaco.Range(active.marker.startLineNumber, 1, active.marker.startLineNumber, 1),
      options: { isWholeLine: true, className: 'diagnostic-active-line' },
    });
  }
  diagnosticDecorations.set(decorations);
}

function createDiagnosticItem(item: DiagnosticView, index: number): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('role', 'listitem');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = `diagnostic-item ${item.severity}`;
  button.dataset.index = String(index);
  button.title = `${formatLocation(item.marker)} · ${item.kind}\n${item.raw}`;
  if (index === activeDiagnostic) button.classList.add('active');

  const icon = document.createElement('span');
  icon.className = 'diagnostic-icon';
  icon.textContent = item.severity === 'error' ? '✕' : '⚠';
  icon.setAttribute('aria-hidden', 'true');

  const main = document.createElement('span');
  main.className = 'diagnostic-main';

  const message = document.createElement('span');
  message.className = 'diagnostic-message';
  message.textContent = item.message;

  const meta = document.createElement('span');
  meta.className = 'diagnostic-meta';
  meta.textContent = `[${item.kind}] ${formatLocation(item.marker)}`;

  main.append(message, meta);

  if (item.raw && item.raw !== item.message) {
    const raw = document.createElement('span');
    raw.className = 'diagnostic-raw';
    raw.textContent = item.raw;
    main.append(raw);
  }

  button.append(icon, main);
  button.addEventListener('click', () => focusDiagnostic(index));
  wrapper.append(button);
  return wrapper;
}

function renderDiagnostics() {
  const validation = $('validation');
  const errorText = $('errorText');
  const errors = diagnostics.filter(item => item.severity === 'error').length;
  const warnings = diagnostics.length - errors;

  if (diagnosticsPending) {
    validation.textContent = '… 校验中';
    validation.className = 'validation pending';
    errorText.textContent = '正在检查 JSON 语法…';
  } else if (!errors && !warnings) {
    validation.textContent = '✓ JSON 有效';
    validation.className = 'validation good';
    errorText.textContent = '无语法错误';
  } else if (!errors) {
    validation.textContent = `⚠ ${warnings} 个警告`;
    validation.className = 'validation warn';
    errorText.textContent = `${formatLocation(diagnostics[0].marker)}：${diagnostics[0].message}`;
  } else {
    validation.textContent = `✕ ${errors} 个错误`;
    validation.className = 'validation bad';
    errorText.textContent = `${formatLocation(diagnostics[0].marker)}：${diagnostics[0].message}`;
  }

  updateDiagnosticsSummary();
  renderEditorDiagnosticDecorations();

  const list = $('diagnosticsList');
  list.textContent = '';
  if (diagnosticsPending) {
    const pending = document.createElement('div');
    pending.className = 'diagnostics-empty pending';
    pending.textContent = '正在校验当前文档…';
    list.append(pending);
    return;
  }
  if (!diagnostics.length) {
    const empty = document.createElement('div');
    empty.className = 'diagnostics-empty';
    empty.textContent = '✓ 未发现问题';
    list.append(empty);
    return;
  }
  diagnostics.slice(0, MAX_RENDERED_DIAGNOSTICS)
    .forEach((item, index) => list.append(createDiagnosticItem(item, index)));
  if (diagnostics.length > MAX_RENDERED_DIAGNOSTICS) {
    const more = document.createElement('div');
    more.className = 'diagnostics-empty pending';
    more.textContent = `还有 ${diagnostics.length - MAX_RENDERED_DIAGNOSTICS} 条问题未显示，请修复后再查看`;
    list.append(more);
  }
}

function setValidationPending() {
  diagnostics = [];
  activeDiagnostic = -1;
  diagnosticsPending = true;
  diagnosticsSignature = '';
  renderDiagnostics();
}

function refreshDiagnostics() {
  const next = collectDiagnostics();
  const nextSignature = diagnosticsKey(next);
  const wasPending = diagnosticsPending;
  diagnosticsPending = false;
  if (!wasPending && nextSignature === diagnosticsSignature) return;
  diagnosticsSignature = nextSignature;
  diagnostics = next;
  activeDiagnostic = -1;
  renderDiagnostics();
}

function scheduleDiagnosticsRefresh(delay = 120) {
  window.clearTimeout(diagnosticsTimer);
  diagnosticsTimer = window.setTimeout(refreshDiagnostics, delay);
}

function updateActiveDiagnosticClass() {
  $('diagnosticsList').querySelectorAll<HTMLButtonElement>('.diagnostic-item').forEach(element => {
    element.classList.toggle('active', Number(element.dataset.index) === activeDiagnostic);
  });
}

function focusDiagnostic(index: number) {
  const item = diagnostics[index];
  if (!item) return;
  const marker = item.marker;
  // 零长度 range 无法形成可见选区，向右扩展一列。
  const endColumn = marker.endLineNumber === marker.startLineNumber && marker.endColumn <= marker.startColumn
    ? marker.startColumn + 1
    : marker.endColumn;
  const range = new monaco.Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, endColumn);
  activeDiagnostic = index;
  editor.setSelection(range);
  editor.revealRangeInCenter(range, monaco.editor.ScrollType.Smooth);
  editor.focus();
  updateActiveDiagnosticClass();
  renderEditorDiagnosticDecorations();
  $('diagnosticsList')
    .querySelector<HTMLElement>(`.diagnostic-item[data-index="${index}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}

function navigateDiagnostic(direction: 1 | -1) {
  if (!diagnostics.length) return;
  setDiagnosticsCollapsed(false);
  const base = activeDiagnostic >= 0 && activeDiagnostic < diagnostics.length
    ? activeDiagnostic
    : (direction > 0 ? -1 : 0);
  focusDiagnostic((base + direction + diagnostics.length) % diagnostics.length);
}

function setDiagnosticsCollapsed(collapsed: boolean) {
  $('diagnosticsPanel').classList.toggle('is-collapsed', collapsed);
  $('diagnosticsToggle').setAttribute('aria-expanded', String(!collapsed));
  $('diagnosticsChevron').textContent = collapsed ? '▸' : '▾';
}

function toggleDiagnosticsPanel() {
  setDiagnosticsCollapsed(!$('diagnosticsPanel').classList.contains('is-collapsed'));
}

// JSON worker 异步产出 marker，输入时立即读取会拿到上一次结果，因此这里以事件为准。
monaco.editor.onDidChangeMarkers((resources) => {
  const model = editor.getModel();
  if (!model) return;
  const current = model.uri.toString();
  if (!resources.some(resource => resource.toString() === current)) return;
  scheduleDiagnosticsRefresh(120);
});

function parseJson(): any {
  const raw = editor.getValue();
  try {
    const value = JSON.parse(raw);
    status('JSON 校验通过', 'success');
    return value;
  } catch (error) {
    // 解析失败只用于阻止操作；行列位置仍取 Monaco 诊断，不解析 JSON.parse 的报错文本。
    const first = diagnostics[0];
    status(first
      ? `JSON 解析失败：${formatLocation(first.marker)} ${first.message}`
      : 'JSON 解析失败，请查看编辑器中的错误标记', 'error');
    // worker 可能还没把最新 marker 推上来，稍后再刷新面板。
    scheduleDiagnosticsRefresh(150);
    throw error;
  }
}
function currentDoc(): FileDoc | null { return mode === 'cloud' ? cloudDoc : localDoc; }
// 切换 Tab / 打开新文件前，把编辑器里的实时内容写回当前模式的文档缓存。
function snapshotDoc() {
  const doc = currentDoc();
  if (doc) doc.text = editor.getValue();
}
function storeDoc(docMode: AppMode, ref: string, title: string, text: string, tag: string): FileDoc {
  const doc: FileDoc = { ref, title, text, tag };
  if (docMode === 'cloud') {
    cloudDoc = doc;
    currentObjectKey = ref;
    currentFile = null;
  } else {
    localDoc = doc;
    currentFile = ref;
    currentObjectKey = null;
  }
  if (mode === docMode) {
    $('fileName').textContent = title;
    $('dirty').textContent = tag;
  }
  return doc;
}
function showEmptyEditor() {
  currentFile = null;
  currentObjectKey = null;
  $('fileName').textContent = '未打开文件';
  editor.setValue('');
  $('dirty').textContent = '● 未命名';
  setValidationPending();
  scheduleDiagnosticsRefresh(300);
}
// 编辑器内容跟随当前模式：有选中的文件则显示该文件，没有则为空文档。
function syncEditorToMode() {
  const doc = currentDoc();
  if (!doc) { showEmptyEditor(); return; }
  currentFile = mode === 'local' ? doc.ref : null;
  currentObjectKey = mode === 'cloud' ? doc.ref : null;
  // setValue 会触发内容变更事件并改写 tag，这里先取出原 tag，写入后恢复。
  const tag = doc.tag;
  editor.setValue(doc.text);
  doc.tag = tag;
  $('fileName').textContent = doc.title;
  $('dirty').textContent = tag;
  setValidationPending();
  scheduleDiagnosticsRefresh(300);
}
// 定位顶层 "version" 数字值的位置，只替换该数字，避免保存时重排整份 JSON。
function findTopLevelVersionRange(text: string): { start: number; end: number } | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      if (depth !== 1) { inString = true; continue; }
      let end = i + 1;
      let key = '';
      while (end < text.length) {
        const c = text[end];
        if (c === '\\') { key += text.slice(end, end + 2); end += 2; continue; }
        if (c === '"') break;
        key += c;
        end++;
      }
      if (key === 'version') {
        let cursor = end + 1;
        while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
        if (text[cursor] === ':') {
          cursor++;
          while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
          const start = cursor;
          if (text[cursor] === '-' || /\d/.test(text[cursor])) {
            cursor++;
            while (cursor < text.length && /[0-9eE+.\-]/.test(text[cursor])) cursor++;
            return { start, end: cursor };
          }
        }
      }
      i = end;
      continue;
    }
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
  }
  return null;
}
// 保存/推送时若顶层 version 是数值则 +1，其余情况保持原文本不变。
function bumpVersion(text: string): { text: string; bumped: boolean } {
  let value: any;
  try { value = JSON.parse(text); } catch { return { text, bumped: false }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { text, bumped: false };
  if (typeof value.version !== 'number' || !Number.isFinite(value.version)) return { text, bumped: false };
  const range = findTopLevelVersionRange(text);
  if (!range) return { text, bumped: false };
  const next = value.version + 1;
  return { text: text.slice(0, range.start) + String(next) + text.slice(range.end), bumped: true };
}
function applyText(text: string) {
  editor.setValue(text);
  editor.focus();
  setValidationPending();
  scheduleDiagnosticsRefresh(600);
}
function formatJson() {
  try { const v = parseJson(); applyText(JSON.stringify(v, null, 2)); status('格式化完成', 'success'); }
  catch {}
}
function minifyJson() {
  try { const v = parseJson(); applyText(JSON.stringify(v)); status('压缩完成', 'success'); }
  catch {}
}
const DEFAULT_COMPACT_KEYS = 'pointCoordinates,sceneinfo,editColorScenes';
const CN_PUNCT_MAP: Record<string, string> = {
  '，': ',', '。': '.', '：': ':', '；': ';', '“': '"', '”': '"', '‘': "'", '’': "'",
  '（': '(', '）': ')', '【': '[', '】': ']', '、': ',', '！': '!', '？': '?', '《': '<', '》': '>', '　': ' ',
};
const CN_PUNCT_RE = /[，。：；\u201c\u201d\u2018\u2019（）【】、！？《》\u3000]/g;
function convertCnPunctuation(text: string): string {
  return text.replace(CN_PUNCT_RE, char => CN_PUNCT_MAP[char] ?? char);
}
function normalizeKeyList(input: string): string[] {
  return convertCnPunctuation(input).split(',').map(key => key.trim()).filter(Boolean);
}
// 键名命中时的压缩规则：二维纯数组整行；三维数组每个二维数组一行；对象数组每个对象一行；其余不压缩。
function compressMatchedArray(value: any[], indent: string): string | null {
  if (!value.length) return null;
  const inner = indent + '  ';
  if (value.every(item => Array.isArray(item) && item.every(cell => Array.isArray(cell)))) {
    return '[\n' + value.map(row => inner + JSON.stringify(row)).join(',\n') + '\n' + indent + ']';
  }
  if (value.every(item => Array.isArray(item))) return JSON.stringify(value);
  if (value.every(item => item && typeof item === 'object' && !Array.isArray(item))) {
    return '[\n' + value.map(item => inner + JSON.stringify(item)).join(',\n') + '\n' + indent + ']';
  }
  return null;
}
function stringifyWithCompaction(value: any, indent: string, key: string | undefined, keys: Set<string>, stats: { matched: number; compressed: number }): string {
  if (Array.isArray(value)) {
    const compressed = key && keys.has(key) ? compressMatchedArray(value, indent) : null;
    if (compressed !== null) { stats.compressed += 1; return compressed; }
    if (!value.length) return '[]';
    const inner = indent + '  ';
    return '[\n' + value.map(item => inner + stringifyWithCompaction(item, inner, undefined, keys, stats)).join(',\n') + '\n' + indent + ']';
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    const inner = indent + '  ';
    return '{\n' + entries.map(([childKey, childValue]) => {
      if (keys.has(childKey)) stats.matched += 1;
      return inner + JSON.stringify(childKey) + ': ' + stringifyWithCompaction(childValue, inner, childKey, keys, stats);
    }).join(',\n') + '\n' + indent + '}';
  }
  return JSON.stringify(value);
}
function compactAtPath() {
  const input = $('compactPath') as HTMLInputElement;
  const keys = normalizeKeyList(input.value);
  if (!keys.length) return status('请输入键名，多个键名用英文逗号分隔', 'error');
  try {
    const root = parseJson();
    const stats = { matched: 0, compressed: 0 };
    const output = stringifyWithCompaction(root, '', undefined, new Set(keys), stats);
    if (!stats.matched) return status(`未找到匹配的键名：${keys.join(', ')}`, 'error');
    if (!stats.compressed) return status(`匹配到 ${stats.matched} 个键名，但对应值不是可压缩的数组`, 'error');
    applyText(output);
    status(`已压缩 ${stats.compressed} 处数组节点（键名：${keys.join(', ')}）`, 'success');
  } catch {}
}
async function openLocal() {
  const selected = await open({ multiple: false, filters: [{ name: 'JSON 文件', extensions: ['json'] }] });
  if (!selected || Array.isArray(selected)) return;
  try {
    const text = await invoke<string>('read_local_json_file', { path: selected });
    applyText(text);
    storeDoc('local', selected, baseName(selected), text, '● 本地文件');
    status('本地文件已打开', 'success');
  } catch (e) { status(zhError(e, '打开本地文件失败'), 'error'); }
}
// 资源管理器双击 .json 打开时，从启动参数载入文件（等同“打开本地 JSON”选择该文件）。
async function openStartupFile(): Promise<boolean> {
  try {
    const file = await invoke<{ path: string; content: string } | null>('take_startup_file');
    if (!file) return false;
    setMode('local');
    applyText(file.content);
    storeDoc('local', file.path, baseName(file.path), file.content, '● 本地文件');
    status(`已打开：${baseName(file.path)}`, 'success');
    return true;
  } catch { return false; }
}
async function saveLocal() {
  try {
    parseJson();
    let path = currentFile;
    if (!path) path = await save({ filters: [{ name: 'JSON 文件', extensions: ['json'] }], defaultPath: 'data.json' });
    if (!path) return;
    if (!path.toLowerCase().endsWith('.json')) path += '.json';
    const bumped = bumpVersion(editor.getValue());
    await invoke('write_local_json_file', { path, body: bumped.text });
    if (bumped.bumped) applyText(bumped.text);
    currentFile = path; currentObjectKey = null;
    if (localDoc) {
      localDoc.ref = path;
      localDoc.title = baseName(path);
      localDoc.text = bumped.text;
      localDoc.tag = '● 已保存';
    } else {
      storeDoc('local', path, baseName(path), bumped.text, '● 已保存');
    }
    $('fileName').textContent = baseName(path); $('dirty').textContent = '● 已保存';
    status(bumped.bumped ? '本地保存成功，version 已 +1' : '本地保存成功', 'success');
    if (mode === 'local') renderTree();
  } catch (e: any) {
    if (e instanceof SyntaxError) return;
    if (e?.message) status(zhError(e, '保存本地文件失败'), 'error');
  }
}
function configFromUI(): S3Config {
  return {
    region: ($('region') as HTMLSelectElement).value as Region,
    bucket: ($('bucket') as HTMLSelectElement).value,
    prefix: ($('prefix') as HTMLInputElement).value.trim(),
    accessKey: ($('accessKey') as HTMLInputElement).value.trim(),
    secretKey: ($('secretKey') as HTMLInputElement).value,
  };
}
function updateCredentialHint(configured: boolean) {
  const hint = $('credentialHint');
  hint.textContent = configured ? '已配置凭据（系统凭据库）' : '尚未配置凭据；保存时需填写访问密钥 ID 与私有访问密钥。';
  hint.className = configured ? 'hint good' : 'hint';
}
function setConfigNote(message: string, kind = '') {
  const note = $('configNote');
  note.textContent = message;
  note.className = kind ? `config-note ${kind}` : 'config-note';
}
async function refreshCredentialHint(region: Region): Promise<boolean> {
  try {
    const configured = await invoke<boolean>('credential_status', { region });
    updateCredentialHint(configured);
    return configured;
  } catch {
    updateCredentialHint(false);
    return false;
  }
}
async function saveS3Config(): Promise<boolean> {
  const c = configFromUI();
  setConfigNote('正在保存配置…');
  if (!c.bucket) {
    setConfigNote('请选择存储桶（Bucket）', 'error');
    status('请选择存储桶（Bucket）', 'error');
    return false;
  }
  if (c.accessKey || c.secretKey) {
    if (!c.accessKey || !c.secretKey) {
      const message = '访问密钥 ID 与私有访问密钥需同时填写';
      setConfigNote(message, 'error');
      status(message, 'error');
      return false;
    }
  }
  try {
    if (c.accessKey && c.secretKey) {
      await invoke('save_s3_credentials', { region: c.region, accessKey: c.accessKey, secretKey: c.secretKey });
      ($('accessKey') as HTMLInputElement).value = '';
      ($('secretKey') as HTMLInputElement).value = '';
    }
    await invoke('save_s3_preferences', { region: c.region, bucket: c.bucket, prefix: c.prefix });
    currentRegion = c.region;
    currentBucket = c.bucket;
    currentPrefix = c.prefix;
    updateBuckets(currentRegion, currentBucket);
    updateCloudContext();
    const configured = await refreshCredentialHint(currentRegion);
    if (!configured) {
      setConfigNote('区域配置已保存，请填写访问密钥后再拉取', 'error');
      status('区域配置已保存，请填写访问密钥后再拉取', 'error');
      return false;
    }
    setConfigNote('S3 配置已保存', 'good');
    status('S3 配置已保存', 'success');
    return true;
  } catch (e) {
    const message = zhError(e, '保存配置失败');
    setConfigNote(message, 'error');
    status(message, 'error');
    return false;
  }
}
async function loadS3Config(): Promise<boolean> {
  try {
    const c = await invoke<any>('load_s3_preferences');
    currentRegion = (c?.region as Region) || 'global';
    currentPrefix = c?.prefix || '';
    ($('region') as HTMLSelectElement).value = currentRegion;
    ($('prefix') as HTMLInputElement).value = currentPrefix;
    updateBuckets(currentRegion, c?.bucket || '');
    currentBucket = ($('bucket') as HTMLSelectElement).value || '';
    const configured = await refreshCredentialHint(currentRegion);
    updateCloudContext();
    return configured;
  } catch {
    updateCredentialHint(false);
    updateCloudContext();
    return false;
  }
}
function updateBuckets(region: Region = currentRegion, selected = '') {
  const opts = region === 'global' ? ['hellofairyapp'] : ['hellofairyfile','hellofairyapp'];
  if (selected && !opts.includes(selected)) opts.unshift(selected);
  const select = $('bucket') as HTMLSelectElement;
  select.innerHTML = opts.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
  select.value = selected && opts.includes(selected) ? selected : opts[0];
}
function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed ? `${trimmed}/` : '';
}

function makeCloudFolder(prefix: string): TreeNode {
  return {
    name: baseName(prefix.replace(/\/+$/, '')),
    displayPath: prefix,
    fullPath: prefix,
    kind: 'folder',
    children: [],
    expanded: false,
    remote: true,
    loaded: false,
  };
}

function makeCloudFile(key: string): TreeNode {
  return {
    name: baseName(key),
    displayPath: key,
    fullPath: key,
    kind: 'file',
    children: [],
    expanded: false,
  };
}

// 只请求当前一层（delimiter 分隔），避免一次列举整桶；文件内容仅在点击时才下载。
async function ensureCloudChildren(node: TreeNode) {
  if (node.kind !== 'folder' || !node.remote || node.loading || node.loaded) return;
  node.loading = true;
  renderTree();
  try {
    const level = await invoke<{ folders: string[]; files: string[] }>('list_s3_level', {
      region: currentRegion,
      bucket: currentBucket,
      prefix: node.fullPath,
    });
    node.children = [
      ...level.folders.map(makeCloudFolder),
      ...level.files.map(makeCloudFile),
    ];
    node.loaded = true;
    node.expanded = true;
    cloudTreeNotice = '';
    status(`当前层级：${level.folders.length} 个文件夹 · ${level.files.length} 个 JSON`, 'success');
  } catch (e) {
    const message = zhError(e, '读取云端目录失败');
    status(message, 'error');
    cloudTreeNotice = message;
    node.loaded = false;
  } finally {
    node.loading = false;
    renderTree();
  }
}

async function toggleFolder(node: TreeNode) {
  if (node.kind !== 'folder') return;
  node.expanded = !node.expanded;
  renderTree();
  if (node.expanded && node.remote && !node.loaded) await ensureCloudChildren(node);
}

function resetCloudRoot() {
  const prefix = normalizePrefix(currentPrefix);
  cloudTreeRoot = {
    name: currentBucket,
    displayPath: prefix,
    fullPath: prefix,
    kind: 'folder',
    children: [],
    expanded: true,
    remote: true,
    loaded: false,
  };
}

function clearCloudSearch() {
  cloudSearchSeq++;
  cloudSearchQuery = '';
  cloudSearchRoots = null;
  cloudSearching = false;
  cloudSearchNotice = '';
  cloudSearchInfo = '';
  const input = document.getElementById('cloudSearch') as HTMLInputElement | null;
  if (input) input.value = '';
}

async function listS3() {
  if (!currentBucket) {
    openS3ConfigModal();
    status('请先配置 S3 存储桶', 'error');
    return;
  }
  if (cloudLoading) return;
  clearCloudSearch();
  cloudLoading = true;
  cloudTreeNotice = '';
  resetCloudRoot();
  renderTree();
  status('正在读取云端目录…');
  const root = cloudTreeRoot;
  try {
    if (root) await ensureCloudChildren(root);
  } finally {
    cloudLoading = false;
    renderTree();
    if (mode === 'cloud') highlightActiveTreeRow();
  }
}

async function runCloudSearch(query: string) {
  cloudSearchQuery = query.trim();
  cloudSearchNotice = '';
  cloudSearchInfo = '';
  cloudSearchRoots = null;
  window.clearTimeout(cloudSearchTimer);
  if (!cloudSearchQuery) {
    cloudSearching = false;
    renderTree();
    return;
  }
  if (!currentBucket) {
    status('请先配置 S3 存储桶', 'error');
    cloudSearchNotice = '请先配置 S3 存储桶';
    renderTree();
    return;
  }
  const seq = ++cloudSearchSeq;
  const scope = cloudSearchScope;
  cloudSearching = true;
  renderTree();
  status(scope === 'level' ? '正在当前层搜索…' : '正在全桶搜索 JSON，首次搜索需要扫描对象列表…');
  try {
    const result = await invoke<{ folders: string[]; files: string[]; truncated: boolean; scanned: number; cached: boolean }>('search_s3_json', {
      region: currentRegion,
      bucket: currentBucket,
      query: cloudSearchQuery,
      scope,
      prefix: normalizePrefix(currentPrefix),
      limit: 500,
    });
    if (seq !== cloudSearchSeq) return;
    // 同级：命中的文件夹保留为懒加载节点，展开时再取下一层；全层级：按完整 key 还原目录层级。
    cloudSearchRoots = scope === 'deep'
      ? (result.files.length ? buildTree(result.files.map(key => ({ displayPath: key, fullPath: key }))) : [])
      : [...result.folders.map(makeCloudFolder), ...result.files.map(makeCloudFile)];
    const matched = result.folders.length + result.files.length;
    cloudSearchInfo = scope === 'deep'
      ? `${matched} 个匹配 · 全桶 ${result.scanned} 个 JSON${result.truncated ? ' · 已截断' : ''}`
      : `${matched} 个匹配 · 当前层 ${result.scanned} 项${result.truncated ? ' · 已截断' : ''}`;
    status(result.truncated
      ? `匹配结果超过 500 个，仅显示前 500 个，请输入更精确的关键词`
      : `搜索完成：${matched} 个匹配${result.cached ? '（缓存）' : ''}`, result.truncated ? '' : 'success');
  } catch (e) {
    if (seq !== cloudSearchSeq) return;
    cloudSearchNotice = zhError(e, '搜索失败');
    status(cloudSearchNotice, 'error');
  } finally {
    if (seq === cloudSearchSeq) {
      cloudSearching = false;
      renderTree();
    }
  }
}
async function loadS3Object(key: string) {
  try {
    const value = await invoke<string>('get_s3_object', { region: currentRegion, bucket: currentBucket, key });
    applyText(value);
    storeDoc('cloud', key, key, value, '● 云端文件');
    status('云端 JSON 已载入', 'success');
    renderTree();
    highlightActiveTreeRow();
  } catch (e) { status(zhError(e, '读取云端文件失败'), 'error'); }
}
async function pushS3() {
  const button = $('pushS3') as HTMLButtonElement;
  if (button.disabled) return;
  if (!currentObjectKey) return status('请先从云端列表打开一个 JSON 文件', 'error');
  if (!currentBucket) return status('请先配置 S3 存储桶', 'error');
  let payload: { text: string; bumped: boolean };
  try {
    parseJson();
    payload = bumpVersion(editor.getValue());
  } catch { return; }
  button.disabled = true;
  button.classList.remove('is-success');
  button.textContent = '推送中...';
  try {
    await invoke('put_s3_object', { region: currentRegion, bucket: currentBucket, key: currentObjectKey, body: payload.text });
    if (payload.bumped) applyText(payload.text);
    if (cloudDoc) { cloudDoc.text = payload.text; cloudDoc.tag = '● 已同步'; }
    $('dirty').textContent = '● 已同步';
    status(payload.bumped ? '已覆盖保存到 S3，version 已 +1' : '已覆盖保存到 S3 原位置', 'success');
    button.classList.add('is-success');
    button.textContent = '推送成功';
    window.setTimeout(() => {
      button.classList.remove('is-success');
      button.textContent = '推送覆盖 S3 原文件';
      button.disabled = false;
    }, 2000);
  } catch (e: any) {
    button.textContent = '推送覆盖 S3 原文件';
    button.disabled = false;
    status(zhError(e.message || e, '推送覆盖失败'), 'error');
  }
}

function closeCurrentFile() {
  if (mode === 'cloud') cloudDoc = null;
  else localDoc = null;
  showEmptyEditor();
  renderTree();
  highlightActiveTreeRow();
  status('已关闭当前文件');
}

function setMode(next: AppMode) {
  const changed = mode !== next;
  if (changed) snapshotDoc();
  mode = next;
  localStorage.setItem(MODE_STORAGE_KEY, next);
  document.body.dataset.mode = next;
  const cloudTab = $('tabCloud');
  const localTab = $('tabLocal');
  cloudTab.classList.toggle('active', next === 'cloud');
  localTab.classList.toggle('active', next === 'local');
  cloudTab.setAttribute('aria-selected', String(next === 'cloud'));
  localTab.setAttribute('aria-selected', String(next === 'local'));
  $('cloudPanel').hidden = next !== 'cloud';
  $('localPanel').hidden = next !== 'local';
  if (changed) syncEditorToMode();
  renderTree();
}

async function openTreeFile(node: TreeNode) {
  if (node.kind !== 'file') return;
  if (mode === 'cloud') await loadS3Object(node.fullPath);
  else await openLocalTreeFile(node);
}

async function openLocalTreeFile(node: TreeNode) {
  if (node.kind !== 'file') return;
  try {
    const text = await invoke<string>('read_local_json_file', { path: node.fullPath });
    applyText(text);
    storeDoc('local', node.fullPath, node.name, text, '● 本地文件');
    status('本地 JSON 已载入', 'success');
    renderTree();
    highlightActiveTreeRow();
  } catch (e) { status(zhError(e, '读取本地文件失败'), 'error'); }
}

async function openLocalFolder() {
  try {
    const selected = await open({ directory: true, multiple: false, title: '选择包含 JSON 的文件夹' });
    if (!selected || Array.isArray(selected)) return;
    localRootPath = selected;
    localRootName = baseName(selected);
    localTreeRoot = null;
    localTreeNotice = '';
    setMode('local');
    await loadLocalTree();
  } catch (e) { status(zhError(e, '打开文件夹失败'), 'error'); }
}

async function loadLocalTree() {
  if (!localRootPath) {
    await openLocalFolder();
    return;
  }
  if (localLoading) return;
  const rootPath = localRootPath;
  localLoading = true;
  localTreeNotice = '';
  status('正在扫描本地 JSON 文件…');
  updateLocalContext();
  renderTree();
  try {
    const entries = await invoke<LocalJsonEntry[]>('list_local_json_tree', { root: rootPath });
    localTreeRoot = {
      name: localRootName || baseName(rootPath),
      displayPath: '',
      fullPath: rootPath,
      kind: 'folder',
      expanded: true,
      children: buildTree(entries.map(entry => ({ displayPath: entry.relative, fullPath: entry.absolute }))),
    };
    status(entries.length ? `找到 ${entries.length} 个 JSON 文件` : '该文件夹中没有 JSON 文件', entries.length ? 'success' : '');
  } catch (e) {
    const message = zhError(e, '扫描本地文件夹失败');
    status(message, 'error');
    localTreeNotice = message;
  } finally {
    localLoading = false;
    renderTree();
    if (mode === 'local') highlightActiveTreeRow();
  }
}

function openS3ConfigModal() {
  const modal = $('configModal');
  if (!modal.hidden) return;
  configReturnFocus = document.activeElement as HTMLElement | null;
  // 每次打开都回填已保存的配置，取消时不会留下未保存的临时选择。
  ($('region') as HTMLSelectElement).value = currentRegion;
  updateBuckets(currentRegion, currentBucket);
  ($('prefix') as HTMLInputElement).value = currentPrefix;
  ($('accessKey') as HTMLInputElement).value = '';
  ($('secretKey') as HTMLInputElement).value = '';
  ($('secretKey') as HTMLInputElement).type = 'password';
  $('toggleSecret').textContent = '显示';
  setConfigNote('');
  modal.hidden = false;
  void refreshCredentialHint(currentRegion);
  requestAnimationFrame(() => ($('accessKey') as HTMLInputElement).focus());
}

function closeS3ConfigModal() {
  const modal = $('configModal');
  if (modal.hidden) return;
  modal.hidden = true;
  ($('accessKey') as HTMLInputElement).value = '';
  ($('secretKey') as HTMLInputElement).value = '';
  configReturnFocus?.focus();
  configReturnFocus = null;
}

function showCompactPaths() {
  try {
    const value = parseJson();
    const names = new Set<string>();
    const walk = (node: any) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        for (const [key, child] of Object.entries(node)) {
          if (Array.isArray(child)) names.add(key);
          walk(child);
        }
      }
    };
    walk(value);
    compactPaths = [...names];
    $('pathList').innerHTML = compactPaths.map(name => `<button class="path" data-path="${esc(name)}">${esc(name)}</button>`).join('');
    document.querySelectorAll<HTMLButtonElement>('.path').forEach(b => b.onclick = () => {
      const keys = normalizeKeyList(compactInput.value);
      const name = b.dataset.path!;
      if (!keys.includes(name)) keys.push(name);
      compactInput.value = keys.join(',');
      compactAtPath();
    });
    status(`发现 ${compactPaths.length} 个数组键名`, 'success');
  } catch {}
}
$('openLocal').onclick = openLocal;
$('saveLocal').onclick = saveLocal;
$('closeFile').onclick = closeCurrentFile;
$('format').onclick = formatJson;
$('minify').onclick = minifyJson;
$('compact').onclick = compactAtPath;
const compactInput = $('compactPath') as HTMLInputElement;
compactInput.value = DEFAULT_COMPACT_KEYS;
// 输入框内中文逗号/顿号自动转英文逗号，光标位置保持不变
compactInput.addEventListener('input', () => {
  const raw = compactInput.value;
  const converted = convertCnPunctuation(raw);
  if (converted === raw) return;
  const caret = compactInput.selectionStart ?? converted.length;
  compactInput.value = converted;
  compactInput.setSelectionRange(caret, caret);
});
// 编辑区输入中文标点时自动替换为英文标点（JSON 仅支持英文符号）
(editor as any).onDidType?.((typed: string) => {
  const converted = convertCnPunctuation(typed);
  if (!typed || converted === typed) return;
  const model = editor.getModel();
  const position = editor.getPosition();
  if (!model || !position) return;
  const endOffset = model.getOffsetAt(position);
  const startOffset = Math.max(0, endOffset - typed.length);
  const start = model.getPositionAt(startOffset);
  editor.executeEdits('cn-punctuation', [{
    range: new monaco.Range(start.lineNumber, start.column, position.lineNumber, position.column),
    text: converted,
    forceMoveMarkers: true,
  }]);
  editor.setPosition(model.getPositionAt(startOffset + converted.length));
});
$('scanPaths').onclick = showCompactPaths;
$('pushS3').onclick = pushS3;
$('tabCloud').onclick = () => setMode('cloud');
$('tabLocal').onclick = () => setMode('local');
$('openS3Config').onclick = openS3ConfigModal;
$('closeS3Config').onclick = closeS3ConfigModal;
$('cancelS3Config').onclick = closeS3ConfigModal;
$('refreshS3').onclick = listS3;
const cloudSearchInput = $('cloudSearch') as HTMLInputElement;
cloudSearchInput.addEventListener('input', () => {
  const value = cloudSearchInput.value;
  window.clearTimeout(cloudSearchTimer);
  cloudSearchTimer = window.setTimeout(() => { void runCloudSearch(value); }, 300);
});
cloudSearchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    clearCloudSearch();
    renderTree();
    return;
  }
  if (event.key !== 'Enter') return;
  event.preventDefault();
  window.clearTimeout(cloudSearchTimer);
  void runCloudSearch(cloudSearchInput.value);
});
$('clearCloudSearch').onclick = () => {
  clearCloudSearch();
  renderTree();
  cloudSearchInput.focus();
};
const cloudSearchScopeSelect = $('cloudSearchScope') as HTMLSelectElement;
cloudSearchScopeSelect.addEventListener('change', () => {
  cloudSearchScope = cloudSearchScopeSelect.value === 'deep' ? 'deep' : 'level';
  if (!cloudSearchQuery) return;
  window.clearTimeout(cloudSearchTimer);
  void runCloudSearch(cloudSearchInput.value);
});
$('openLocalFolder').onclick = openLocalFolder;
$('refreshLocal').onclick = loadLocalTree;
$('saveConfig').onclick = async () => {
  if (!(await saveS3Config())) return;
  closeS3ConfigModal();
  setMode('cloud');
  await listS3();
};
$('configModal').querySelectorAll<HTMLElement>('[data-close="true"]').forEach(el => el.addEventListener('click', closeS3ConfigModal));
$('configModal').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); closeS3ConfigModal(); return; }
  if (event.key !== 'Tab') return;
  const focusables = Array.from($('configModal').querySelectorAll<HTMLElement>('button, select, input'));
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
$('region').onchange = () => {
  const region = ($('region') as HTMLSelectElement).value as Region;
  updateBuckets(region);
  ($('accessKey') as HTMLInputElement).value = '';
  ($('secretKey') as HTMLInputElement).value = '';
  setConfigNote('');
  void refreshCredentialHint(region);
};
$('toggleSecret').onclick = () => { const el = $('secretKey') as HTMLInputElement; const show = el.type === 'password'; el.type = show ? 'text' : 'password'; $('toggleSecret').textContent = show ? '隐藏' : '显示'; };
function bindAction(id: string, handler: () => void) {
  const element = $(id);
  element.addEventListener('click', handler);
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handler();
    }
  });
}

bindAction('diagnosticsToggle', toggleDiagnosticsPanel);
const openFirstDiagnostic = () => {
  setDiagnosticsCollapsed(false);
  if (diagnostics.length) focusDiagnostic(0);
};
bindAction('validation', openFirstDiagnostic);
bindAction('errorText', openFirstDiagnostic);
window.addEventListener('keydown', (event) => {
  if (event.key !== 'F8') return;
  event.preventDefault();
  if (!diagnostics.length) return;
  navigateDiagnostic(event.shiftKey ? -1 : 1);
});

updateBuckets();
setDirty();
setValidationPending();
scheduleDiagnosticsRefresh(600);
void loadS3Config().then(async (configured) => {
  if (await openStartupFile()) return;
  const savedMode: AppMode = localStorage.getItem(MODE_STORAGE_KEY) === 'local' ? 'local' : 'cloud';
  setMode(savedMode);
  if (savedMode === 'cloud' && configured && currentBucket) void listS3();
});
