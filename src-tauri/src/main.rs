#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use aws_config::BehaviorVersion;
use aws_credential_types::Credentials;
use aws_sdk_s3::{config::Region, Client};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const GLOBAL_REGION: &str = "us-east-1";
const CN_REGION: &str = "cn-north-1";
const CN_ENDPOINT: &str = "https://s3.cn-north-1.amazonaws.com.cn";
const GLOBAL_PUBLIC_URL: &str = "https://hellofairyapp.s3.us-east-1.amazonaws.com";
const CN_PUBLIC_URL: &str = "https://hellofairyfile.s3.cn-north-1.amazonaws.com.cn";

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RegionChoice { Global, China }

impl RegionChoice {
    fn region(&self) -> &'static str { match self { Self::Global => GLOBAL_REGION, Self::China => CN_REGION } }
    fn endpoint(&self) -> Option<&'static str> { match self { Self::Global => None, Self::China => Some(CN_ENDPOINT) } }
    // 系统凭据库的服务标识，改动会导致已保存的密钥读不到，必须保持不变。
    fn service(&self) -> &'static str { match self { Self::Global => "json-studio-s3-global", Self::China => "json-studio-s3-china" } }
}

#[derive(Default, Serialize, Deserialize)]
struct Preferences { region: Option<RegionChoice>, bucket: Option<String>, prefix: Option<String> }

fn keyring_entry(region: RegionChoice) -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.local.jsonstudio", region.service())
        .map_err(|e| format!("初始化系统凭据库失败：{e}"))
}

#[tauri::command]
fn save_s3_credentials(region: RegionChoice, access_key: String, secret_key: String) -> Result<(), String> {
    if access_key.trim().is_empty() || secret_key.trim().is_empty() { return Err("访问密钥 ID 与私有访问密钥不能为空".into()); }
    let value = serde_json::json!({"access_key": access_key, "secret_key": secret_key}).to_string();
    keyring_entry(region)?.set_password(&value).map_err(|e| format!("写入系统凭据库失败：{e}"))
}

#[tauri::command]
fn credential_status(region: RegionChoice) -> bool {
    keyring_entry(region).and_then(|e| e.get_password().map_err(|x| x.to_string())).is_ok()
}

fn preferences_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| format!("获取应用配置目录失败：{e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建应用配置目录失败：{e}"))?;
    Ok(dir.join("s3-preferences.json"))
}

#[tauri::command]
fn save_s3_preferences(region: RegionChoice, bucket: String, prefix: String, app: AppHandle) -> Result<(), String> {
    let p = Preferences { region: Some(region), bucket: Some(bucket), prefix: Some(prefix) };
    let bytes = serde_json::to_vec_pretty(&p).map_err(|e| format!("序列化配置失败：{e}"))?;
    fs::write(preferences_path(&app)?, bytes).map_err(|e| format!("保存配置失败：{e}"))
}

#[tauri::command]
fn load_s3_preferences(app: AppHandle) -> Preferences {
    preferences_path(&app).ok()
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<Preferences>(&bytes).ok())
        .unwrap_or_default()
}

async fn s3_client(region: RegionChoice) -> Result<Client, String> {
    let raw = keyring_entry(region)?.get_password().map_err(|_| "尚未保存此区域的 S3 凭据".to_string())?;
    let data: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("解析已保存的凭据失败：{e}"))?;
    let access = data["access_key"].as_str().ok_or("凭据中缺少访问密钥 ID")?;
    let secret = data["secret_key"].as_str().ok_or("凭据中缺少私有访问密钥")?;
    let creds = Credentials::new(access, secret, None, None, "json-studio");
    let mut builder = aws_sdk_s3::Config::builder()
        .region(Region::new(region.region()))
        .credentials_provider(creds)
        .behavior_version_latest();
    if let Some(endpoint) = region.endpoint() { builder = builder.endpoint_url(endpoint).force_path_style(true); }
    Ok(Client::from_conf(builder.build()))
}

#[derive(Serialize)]
struct LocalJsonEntry {
    relative: String,
    absolute: String,
}

fn collect_local_json_files(dir: &std::path::Path, rel: &str, out: &mut Vec<LocalJsonEntry>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("读取文件夹失败：{e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取文件夹项失败：{e}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let file_type = entry.file_type().map_err(|e| format!("读取文件类型失败：{e}"))?;
        if file_type.is_symlink() { continue; }
        let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        if file_type.is_dir() {
            // 跳过明显无关且可能非常庞大的目录；其余子目录读取失败时继续扫描。
            if name == "node_modules" || name == "target" || name == ".git" { continue; }
            let _ = collect_local_json_files(&path, &child_rel, out);
            if out.len() > 10000 { return Err("JSON 文件超过 10000 个，请选择更小的文件夹".into()); }
        } else if file_type.is_file() && name.to_ascii_lowercase().ends_with(".json") {
            out.push(LocalJsonEntry { relative: child_rel, absolute: path.to_string_lossy().to_string() });
            if out.len() > 10000 { return Err("JSON 文件超过 10000 个，请选择更小的文件夹".into()); }
        }
    }
    Ok(())
}

#[tauri::command]
fn list_local_json_tree(root: String) -> Result<Vec<LocalJsonEntry>, String> {
    let path = std::path::PathBuf::from(&root);
    if !path.is_dir() { return Err("所选路径不是文件夹".into()); }
    let mut output = Vec::new();
    collect_local_json_files(&path, "", &mut output)?;
    output.sort_by(|a, b| a.relative.to_lowercase().cmp(&b.relative.to_lowercase()));
    Ok(output)
}

#[tauri::command]
fn read_local_json_file(path: String) -> Result<String, String> {
    if !path.to_ascii_lowercase().ends_with(".json") { return Err("仅允许读取 .json 文件".into()); }
    let bytes = fs::read(&path).map_err(|e| format!("读取本地文件失败：{e}"))?;
    let text = String::from_utf8(bytes).map_err(|e| format!("文件不是有效 UTF-8：{e}"))?;
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

#[tauri::command]
fn write_local_json_file(path: String, body: String) -> Result<(), String> {
    if !path.to_ascii_lowercase().ends_with(".json") { return Err("仅允许写入 .json 文件".into()); }
    serde_json::from_str::<serde_json::Value>(&body).map_err(|e| format!("JSON 校验失败：{e}"))?;
    fs::write(&path, body).map_err(|e| format!("写入本地文件失败：{e}"))
}

fn is_json_key(key: &str) -> bool { key.to_ascii_lowercase().ends_with(".json") }

// 只读取对象元数据（ListObjectsV2），不下载任何文件内容。
#[derive(Serialize)]
struct S3Level {
    folders: Vec<String>,
    files: Vec<String>,
}

// 按层级列举：delimiter 让 S3 只返回当前层，避免一次扫描整桶造成长时间等待。
async fn list_level_page(
    client: &Client,
    bucket: &str,
    prefix: &str,
    continuation: Option<&str>,
) -> Result<aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output, String> {
    let mut req = client.list_objects_v2().bucket(bucket).delimiter("/");
    if !prefix.is_empty() { req = req.prefix(prefix); }
    if let Some(token) = continuation { req = req.continuation_token(token); }
    req.send().await.map_err(|e| format!("S3 列表请求失败：{e}"))
}

#[tauri::command]
async fn list_s3_level(region: RegionChoice, bucket: String, prefix: String) -> Result<S3Level, String> {
    let client = s3_client(region).await?;
    let mut folders: Vec<String> = Vec::new();
    let mut files: Vec<String> = Vec::new();
    let mut continuation: Option<String> = None;
    loop {
        let result = list_level_page(&client, &bucket, &prefix, continuation.as_deref()).await?;
        for common in result.common_prefixes() {
            if let Some(child) = common.prefix() { folders.push(child.to_string()); }
        }
        for item in result.contents() {
            if let Some(key) = item.key() {
                if is_json_key(key) { files.push(key.to_string()); }
            }
        }
        if result.is_truncated().unwrap_or(false) {
            continuation = result.next_continuation_token().map(str::to_string);
            if continuation.is_none() { break; }
        } else { break; }
    }
    folders.sort();
    folders.dedup();
    files.sort();
    files.dedup();
    Ok(S3Level { folders, files })
}

async fn list_all_json_keys(client: &Client, bucket: &str) -> Result<Vec<String>, String> {
    let mut continuation: Option<String> = None;
    let mut output = Vec::new();
    loop {
        let mut req = client.list_objects_v2().bucket(bucket);
        if let Some(token) = continuation.as_deref() { req = req.continuation_token(token); }
        let result = req.send().await.map_err(|e| format!("S3 列表请求失败：{e}"))?;
        for item in result.contents() {
            if let Some(key) = item.key() {
                if is_json_key(key) { output.push(key.to_string()); }
            }
        }
        if result.is_truncated().unwrap_or(false) {
            continuation = result.next_continuation_token().map(str::to_string);
            if continuation.is_none() { break; }
        } else { break; }
    }
    output.sort();
    output.dedup();
    Ok(output)
}

// 全桶搜索必须有完整 key 列表，这里把首次扫描结果缓存 5 分钟，后续输入直接命中缓存。
const SEARCH_CACHE_TTL: Duration = Duration::from_secs(300);
const SEARCH_LIMIT_MAX: usize = 1000;
static SEARCH_CACHE: OnceLock<Mutex<HashMap<String, (Instant, Vec<String>)>>> = OnceLock::new();

#[derive(Serialize)]
struct S3SearchResult {
    folders: Vec<String>,
    files: Vec<String>,
    truncated: bool,
    scanned: usize,
    cached: bool,
}

fn name_matches(prefix_or_key: &str, needle: &str) -> bool {
    let trimmed = prefix_or_key.trim_end_matches('/');
    let name = trimmed.rsplit('/').next().unwrap_or(trimmed);
    name.to_lowercase().contains(needle)
}

// scope = "level"：只列举当前层（文件夹 + 文件）并按名称模糊匹配，命中的文件夹交由前端懒加载展开；
// scope = "deep"：扫描整桶 key 列表（仅元数据）后按完整路径模糊匹配，首次结果缓存 5 分钟。
#[tauri::command]
async fn search_s3_json(region: RegionChoice, bucket: String, query: String, scope: String, prefix: String, limit: usize) -> Result<S3SearchResult, String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(S3SearchResult { folders: Vec::new(), files: Vec::new(), truncated: false, scanned: 0, cached: false });
    }
    let cap = limit.clamp(1, SEARCH_LIMIT_MAX);

    if scope != "deep" {
        let client = s3_client(region).await?;
        let mut folders: Vec<String> = Vec::new();
        let mut files: Vec<String> = Vec::new();
        let mut matched = 0usize;
        let mut scanned = 0usize;
        let mut truncated = false;
        let mut continuation: Option<String> = None;
        loop {
            let result = list_level_page(&client, &bucket, &prefix, continuation.as_deref()).await?;
            for common in result.common_prefixes() {
                let Some(child) = common.prefix() else { continue };
                scanned += 1;
                if !name_matches(child, &needle) { continue; }
                if matched >= cap { truncated = true; break; }
                matched += 1;
                folders.push(child.to_string());
            }
            if truncated { break; }
            for item in result.contents() {
                let Some(key) = item.key() else { continue };
                scanned += 1;
                if !is_json_key(key) || !name_matches(key, &needle) { continue; }
                if matched >= cap { truncated = true; break; }
                matched += 1;
                files.push(key.to_string());
            }
            if truncated { break; }
            if result.is_truncated().unwrap_or(false) {
                continuation = result.next_continuation_token().map(str::to_string);
                if continuation.is_none() { break; }
            } else { break; }
        }
        folders.sort();
        folders.dedup();
        files.sort();
        files.dedup();
        return Ok(S3SearchResult { folders, files, truncated, scanned, cached: false });
    }

    let cache = SEARCH_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let cache_key = format!("{}|{}", region.region(), bucket);
    let hit = cache.lock().ok()
        .and_then(|guard| guard.get(&cache_key).cloned())
        .filter(|(at, _)| at.elapsed() < SEARCH_CACHE_TTL);
    let (all, cached) = match hit {
        Some((_, keys)) => (keys, true),
        None => {
            let client = s3_client(region).await?;
            let keys = list_all_json_keys(&client, &bucket).await?;
            if let Ok(mut guard) = cache.lock() {
                guard.insert(cache_key, (Instant::now(), keys.clone()));
            }
            (keys, false)
        }
    };
    let mut files = Vec::new();
    let mut truncated = false;
    for key in &all {
        if !key.to_lowercase().contains(&needle) { continue; }
        if files.len() >= cap { truncated = true; break; }
        files.push(key.clone());
    }
    Ok(S3SearchResult { folders: Vec::new(), files, truncated, scanned: all.len(), cached })
}

#[tauri::command]
async fn get_s3_object(region: RegionChoice, bucket: String, key: String) -> Result<String, String> {
    if !key.to_ascii_lowercase().ends_with(".json") { return Err("仅允许读取 .json 文件".into()); }
    let client = s3_client(region).await?;
    let response = client.get_object().bucket(bucket).key(key).send().await.map_err(|e| format!("S3 下载失败：{e}"))?;
    let bytes = response.body.collect().await.map_err(|e| format!("读取云端文件内容失败：{e}"))?.into_bytes();
    String::from_utf8(bytes.to_vec()).map_err(|e| format!("文件不是有效 UTF-8：{e}"))
}

#[tauri::command]
async fn put_s3_object(region: RegionChoice, bucket: String, key: String, body: String) -> Result<(), String> {
    if !key.to_ascii_lowercase().ends_with(".json") { return Err("仅允许写入 .json 文件".into()); }
    serde_json::from_str::<serde_json::Value>(&body).map_err(|e| format!("JSON 校验失败：{e}"))?;
    let client = s3_client(region).await?;
    client.put_object().bucket(bucket).key(key).body(body.into_bytes().into()).content_type("application/json; charset=utf-8").send().await.map_err(|e| format!("S3 上传失败：{e}"))?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![save_s3_credentials, credential_status, save_s3_preferences, load_s3_preferences, list_s3_level, search_s3_json, get_s3_object, put_s3_object, list_local_json_tree, read_local_json_file, write_local_json_file])
        .run(tauri::generate_context!())
        .expect("应用启动失败");
}
