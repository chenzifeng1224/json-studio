import './style.css';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';

(self as any).MonacoEnvironment = { getWorker(_: string, label: string) { return label === 'json' ? new jsonWorker() : new editorWorker(); } };

type Region = 'global' | 'china';
type S3Config = { region: Region; bucket: string; prefix: string; accessKey: string; secretKey: string };
let editor: monaco.editor.IStandaloneCodeEditor;
let currentFile: string | null = null;
let currentObjectKey: string | null = null;
let valid = true;
let compactPaths: string[] = [];
let currentRegion: Region = 'global';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (message: string, kind = '') => { $('status').textContent = message; $('status').className = `status ${kind}`; };
const setDirty = () => $('dirty').textContent = currentFile || currentObjectKey ? '● 已载入' : '● 未命名';
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

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
const zhError = (e: unknown, prefix = '操作失败') => {
  const raw = String(e ?? '').replace(/^Error:\s*/i, '').trim();
  if (!raw) return `${prefix}：未知错误`;
  const translated = translateError(raw);
  const pos = raw.match(/position\s+(\d+)/i);
  const where = pos ? `（字符位置 ${pos[1]}）` : '';
  if (translated) return `${prefix}：${translated}${where}`;
  // 后端已返回中文说明时直接使用；纯英文错误补中文说明，原文附后便于排查。
  return /[\u4e00-\u9fa5]/.test(raw) ? raw : `${prefix}：${raw}`;
};
const zhDiagnostic = (message: string) =>
  translateError(message) || (/[\u4e00-\u9fa5]/.test(message) ? message : `语法错误：${message}`);

monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
  validate: true, allowComments: false, schemas: [], enableSchemaRequest: false,
  comments: 'error', trailingCommas: 'error'
});
editor = monaco.editor.create($('editor'), {
  value: '{\n  "示例": "你好，JSON Studio",\n  "items": [1, 2, 3]\n}',
  language: 'json', theme: 'vs-dark', automaticLayout: true, minimap: { enabled: true },
  fontSize: 14, tabSize: 2, insertSpaces: true, wordWrap: 'off',
  bracketPairColorization: { enabled: true }, guides: { bracketPairs: true, highlightActiveBracketPair: true },
  matchBrackets: 'always', padding: { top: 14, bottom: 14 }, scrollBeyondLastLine: false
});
editor.onDidChangeModelContent(() => { $('dirty').textContent = '● 有未保存修改'; validateNow(); });
editor.onDidChangeCursorPosition(() => highlightMatchingBracket());

function validateNow() {
  const model = editor.getModel(); if (!model) return;
  const markers = monaco.editor.getModelMarkers({ resource: model.uri });
  const errors = markers.filter(m => m.severity === monaco.MarkerSeverity.Error);
  valid = errors.length === 0;
  $('validation').textContent = valid ? '✓ JSON 有效' : `✕ ${errors.length} 处语法错误`;
  $('validation').className = valid ? 'validation good' : 'validation bad';
  if (errors.length) $('errorText').textContent = `第 ${errors[0].startLineNumber} 行第 ${errors[0].startColumn} 列：${zhDiagnostic(errors[0].message)}`;
  else $('errorText').textContent = '无语法错误';
}
function highlightMatchingBracket() {
  const model = editor.getModel(); if (!model) return;
  const pos = editor.getPosition(); if (!pos) return;
  const line = model.getLineContent(pos.lineNumber);
  const col = pos.column - 1;
  const pairs: Record<string,string> = { '{':'}', '[':']', '}':'{', ']':'[' };
  const ch = line[col] || line[col - 1];
  if (!ch || !pairs[ch]) { bracketDecoration.set([]); return; }
  const offset = model.getOffsetAt({ lineNumber: pos.lineNumber, column: ch === line[col] ? col + 1 : col });
  const text = model.getValue(); const openChar = ch === '{' || ch === '[' ? ch : pairs[ch];
  const closeChar = pairs[openChar]; let depth = 0, match = -1, direction = ch === openChar ? 1 : -1;
  for (let i = offset - (direction === 1 ? 0 : 1); i >= 0 && i < text.length; i += direction) {
    const c = text[i];
    if (c === openChar) depth += direction === 1 ? 1 : -1;
    if (c === closeChar) depth += direction === 1 ? -1 : 1;
    if (depth === 0) { match = i; break; }
  }
  if (match < 0) { bracketDecoration.set([]); return; }
  const a = model.getPositionAt(offset - (direction === 1 ? 0 : 1));
  const b = model.getPositionAt(match);
  bracketDecoration.set([a,b].map(p => ({ range: new monaco.Range(p.lineNumber,p.column,p.lineNumber,p.column+1), options: { inlineClassName: 'bracket-match-strong', overviewRuler: { color: '#ffd166', position: monaco.editor.OverviewRulerLane.Center } } })));
}
const bracketDecoration = editor.createDecorationsCollection([]);

function parseJson(): any {
  const raw = editor.getValue();
  try { const value = JSON.parse(raw); status('JSON 校验通过', 'success'); return value; }
  catch (e: any) { status(zhError(e, 'JSON 解析失败'), 'error'); throw e; }
}
function applyText(text: string) { editor.setValue(text); editor.focus(); validateNow(); }
function formatJson() {
  try { const v = parseJson(); applyText(JSON.stringify(v, null, 2)); status('格式化完成', 'success'); }
  catch {}
}
function minifyJson() {
  try { const v = parseJson(); applyText(JSON.stringify(v)); status('压缩完成', 'success'); }
  catch {}
}
function compactAtPath() {
  const path = ($('compactPath') as HTMLInputElement).value.trim();
  if (!path) return status('请输入路径，例如 data.items 或 $.data.items', 'error');
  try {
    const root = parseJson(); const parts = path.replace(/^\$\.?/, '').split('.').filter(Boolean);
    let node = root;
    for (const part of parts) {
      const m = part.match(/^([^[]+)|\[(\d+)\]$/g);
      if (part.startsWith('[')) node = node[Number(part.slice(1,-1))];
      else node = node?.[part];
    }
    if (node === undefined) return status('路径不存在', 'error');
    const replacement = JSON.stringify(node);
    const needle = JSON.stringify(node, null, 2);
    const source = editor.getValue();
    const index = source.indexOf(needle);
    if (index < 0) return status('无法唯一定位该节点，请先格式化 JSON 后重试', 'error');
    applyText(source.slice(0,index) + replacement + source.slice(index + needle.length));
    status(`已压缩节点：${path}`, 'success');
  } catch {}
}
async function openLocal() {
  const selected = await open({ multiple: false, filters: [{ name: 'JSON 文件', extensions: ['json'] }] });
  if (!selected || Array.isArray(selected)) return;
  try { applyText(await readTextFile(selected)); currentFile = selected; currentObjectKey = null; $('fileName').textContent = selected.split(/[\\/]/).pop()!; setDirty(); status('本地文件已打开', 'success'); }
  catch (e) { status(zhError(e, '打开本地文件失败'), 'error'); }
}
async function saveLocal() {
  try { parseJson(); let path = currentFile;
    if (!path) path = await save({ filters: [{ name: 'JSON 文件', extensions: ['json'] }], defaultPath: 'data.json' });
    if (!path) return;
    await writeTextFile(path, editor.getValue()); currentFile = path; currentObjectKey = null;
    $('fileName').textContent = path.split(/[\\/]/).pop()!; $('dirty').textContent = '● 已保存'; status('本地保存成功', 'success');
  } catch (e: any) { if (e?.message) status(zhError(e, '保存本地文件失败'), 'error'); }
}
function configFromUI(): S3Config {
  return { region: currentRegion, bucket: ($('bucket') as HTMLSelectElement).value, prefix: ($('prefix') as HTMLInputElement).value.trim(), accessKey: ($('accessKey') as HTMLInputElement).value.trim(), secretKey: ($('secretKey') as HTMLInputElement).value };
}
async function saveS3Config() {
  const c = configFromUI();
  if (!c.bucket) return status('请选择存储桶（Bucket）', 'error');
  try {
    if (c.accessKey && c.secretKey) await invoke('save_s3_credentials', { region: c.region, accessKey: c.accessKey, secretKey: c.secretKey });
    else if (c.accessKey || c.secretKey) return status('访问密钥 ID 与私有访问密钥需同时填写', 'error');
    await invoke('save_s3_preferences', { region: c.region, bucket: c.bucket, prefix: c.prefix });
    const configured = await invoke<boolean>('credential_status', { region: c.region });
    $('credentialHint').textContent = configured ? '已配置凭据（系统凭据库）' : '尚未配置凭据';
    status(configured ? '配置已保存到本机' : '区域配置已保存，请填写密钥', 'success');
  }
  catch(e) { status(zhError(e, '保存配置失败'), 'error'); }
}
async function loadS3Config() {
  try {
    const c = await invoke<any>('load_s3_preferences');
    if (c) { currentRegion = c.region || 'global'; ($('region') as HTMLSelectElement).value = currentRegion; ($('prefix') as HTMLInputElement).value = c.prefix || ''; updateBuckets(); ($('bucket') as HTMLSelectElement).value = c.bucket || ''; }
    const keys = await invoke<any>('credential_status', { region: currentRegion });
    $('credentialHint').textContent = keys ? '已配置凭据（系统凭据库）' : '尚未配置凭据';
  } catch {}
}
function updateBuckets() {
  const opts = currentRegion === 'global' ? ['hellofairyapp'] : ['hellofairyfile','hellofairyapp'];
  $('bucket').innerHTML = opts.map(x => `<option value="${x}">${x}</option>`).join('');
}
async function listS3() {
  const c = configFromUI();
  try {
    if (c.accessKey && c.secretKey) await saveS3Config();
    else await invoke('save_s3_preferences', { region: c.region, bucket: c.bucket, prefix: c.prefix });
    const keys = await invoke<string[]>('list_json_objects', { region: c.region, bucket: c.bucket, prefix: c.prefix });
    $('objectList').innerHTML = keys.map(k => `<button class="object" data-key="${esc(k)}">${esc(k)}</button>`).join('') || '<div class="empty">该路径下没有 JSON 文件</div>';
    document.querySelectorAll<HTMLButtonElement>('.object').forEach(b => b.onclick = () => loadS3Object(b.dataset.key!));
    status(`找到 ${keys.length} 个 JSON 文件`, 'success');
  } catch(e) { status(zhError(e, '拉取 JSON 列表失败'), 'error'); }
}
async function loadS3Object(key: string) {
  const c = configFromUI();
  try { const value = await invoke<string>('get_s3_object', { region: c.region, bucket: c.bucket, key }); applyText(value); currentObjectKey = key; currentFile = null; $('fileName').textContent = key; $('dirty').textContent = '● 云端文件'; status('云端 JSON 已载入', 'success'); }
  catch(e) { status(zhError(e, '读取云端文件失败'), 'error'); }
}
async function pushS3() {
  if (!currentObjectKey) return status('请先从 S3 列表打开一个 JSON 文件', 'error');
  try { parseJson(); const c = configFromUI(); await invoke('put_s3_object', { region: c.region, bucket: c.bucket, key: currentObjectKey, body: editor.getValue() }); $('dirty').textContent = '● 已同步'; status('已覆盖保存到 S3 原位置', 'success'); }
  catch(e: any) { status(zhError(e.message || e, '推送覆盖失败'), 'error'); }
}
function showCompactPaths() {
  try {
    const value = parseJson(); const paths: string[] = [];
    const walk = (v: any, p: string) => {
      if (Array.isArray(v) || (v && typeof v === 'object')) {
        paths.push(p || '$');
        if (Array.isArray(v)) v.forEach((x,i) => walk(x, `${p}[${i}]`));
        else Object.keys(v).forEach(k => walk(v[k], p ? `${p}.${k}` : k));
      }
    };
    walk(value, ''); compactPaths = paths;
    $('pathList').innerHTML = paths.map(p => `<button class="path" data-path="${esc(p)}">${esc(p)}</button>`).join('');
    document.querySelectorAll<HTMLButtonElement>('.path').forEach(b => b.onclick = () => { ($('compactPath') as HTMLInputElement).value = b.dataset.path!; compactAtPath(); });
    status(`发现 ${paths.length} 个对象/数组节点`, 'success');
  } catch {}
}
$('openLocal').onclick = openLocal; $('saveLocal').onclick = saveLocal;
$('format').onclick = formatJson; $('minify').onclick = minifyJson; $('compact').onclick = compactAtPath; $('scanPaths').onclick = showCompactPaths;
$('saveConfig').onclick = saveS3Config; $('refreshS3').onclick = listS3; $('pushS3').onclick = pushS3;
$('region').onchange = () => { currentRegion = ($('region') as HTMLSelectElement).value as Region; updateBuckets(); ($('accessKey') as HTMLInputElement).value = ''; ($('secretKey') as HTMLInputElement).value = ''; loadS3Config(); };
$('toggleSecret').onclick = () => { const el = $('secretKey') as HTMLInputElement; const show = el.type === 'password'; el.type = show ? 'text' : 'password'; $('toggleSecret').textContent = show ? '隐藏' : '显示'; };
updateBuckets(); loadS3Config(); validateNow(); setDirty();
