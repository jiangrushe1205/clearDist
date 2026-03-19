use serde::Serialize;
use sysinfo::Disks;
use tauri::{AppHandle, Emitter, State};
use std::thread;
use std::time::Duration;
use std::fs;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use std::path::PathBuf;
use std::collections::HashMap;
use rayon::prelude::*;

#[derive(Serialize)]
pub struct DriveInfo {
    pub letter: String,
    pub name: String,
    pub total_space: u64,
    pub available_space: u64,
}

// 轻量级文件结构
#[derive(Serialize, Clone, Debug)]
pub struct FileInfo {
    pub name: String,
    pub size: u64,
    pub path: String,
}

// 目录节点结构
#[derive(Serialize, Clone, Debug)]
pub struct FolderNode {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub sub_folders: Vec<String>, // 子目录路径列表
    pub files: Vec<FileInfo>,     // 直接包含的文件列表，不再作为独立节点
}

#[derive(Serialize, Clone)]
pub struct ScanProgress {
    pub files_scanned: u64,
    pub folders_scanned: u64,
}

// 后端全局状态，仅存储目录树
pub struct AppState {
    pub folders: Mutex<HashMap<String, FolderNode>>,
    pub is_scanning: Mutex<bool>,
    pub file_count: AtomicU64,
    pub folder_count: AtomicU64,
}

#[tauri::command]
fn get_drives() -> Vec<DriveInfo> {
    let disks = Disks::new_with_refreshed_list();
    let mut drives = Vec::new();

    for disk in disks.iter() {
        let mount_point = disk.mount_point().to_string_lossy().to_string();
        let name = if mount_point == "C:\\" || mount_point == "/" { "系统" } else { "本地磁盘" };
        drives.push(DriveInfo {
            letter: mount_point,
            name: name.to_string(),
            total_space: disk.total_space(),
            available_space: disk.available_space(),
        });
    }
    drives
}

// 递归扫描：只为目录建立索引，文件直接归并到父级
fn scan_recursive(path: PathBuf, folders: &Mutex<HashMap<String, FolderNode>>, f_count: &AtomicU64, d_count: &AtomicU64) -> u64 {
    let path_str = path.to_string_lossy().to_string();
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path_str.clone());

    let entries = match fs::read_dir(&path) {
        Ok(read) => read.filter_map(|res| res.ok()).collect::<Vec<_>>(),
        Err(_) => {
            folders.lock().unwrap().insert(path_str, FolderNode {
                path: String::new(),
                name,
                size: 0,
                sub_folders: Vec::new(),
                files: Vec::new(),
            });
            return 0;
        }
    };

    d_count.fetch_add(1, Ordering::Relaxed);

    // 分离目录和文件
    let mut current_files = Vec::new();
    let mut sub_dirs = Vec::new();

    for entry in entries {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let p = entry.path();
        if meta.is_dir() {
            sub_dirs.push(p);
        } else {
            f_count.fetch_add(1, Ordering::Relaxed);
            current_files.push(FileInfo {
                name: entry.file_name().to_string_lossy().to_string(),
                size: meta.len(),
                path: p.to_string_lossy().to_string(),
            });
        }
    }

    // 并行递归子目录
    let sub_results: Vec<(String, u64)> = sub_dirs.into_par_iter().map(|p| {
        let ps = p.to_string_lossy().to_string();
        let size = scan_recursive(p, folders, f_count, d_count);
        (ps, size)
    }).collect();

    let mut total_size: u64 = current_files.iter().map(|f| f.size).sum::<u64>();
    let mut sub_folder_paths = Vec::new();
    for (ps, size) in sub_results {
        total_size += size;
        sub_folder_paths.push(ps);
    }

    let node = FolderNode {
        path: path_str.clone(),
        name,
        size: total_size,
        sub_folders: sub_folder_paths,
        files: current_files,
    };
    folders.lock().unwrap().insert(path_str, node);
    total_size
}

// 临时文件信息结构
#[derive(Serialize)]
pub struct TempItem {
    pub name: String,
    pub path: String, // 用于显示的路径（通常是应用根目录）
    pub cache_paths: Vec<String>, // 实际需要清理的路径列表
    pub size: u64,
}

#[derive(Serialize)]
pub struct TempCategory {
    pub name: String,
    pub items: Vec<TempItem>,
    pub total_size: u64,
}

#[derive(Serialize)]
pub struct TempInfo {
    pub categories: Vec<TempCategory>,
}

#[tauri::command]
fn get_temp_info() -> TempInfo {
    let mut categories = Vec::new();

    // 1. 系统级别临时文件
    let mut system_items = Vec::new();
    let sys_temp = PathBuf::from("C:\\Windows\\Temp");
    if sys_temp.exists() {
        system_items.push(TempItem {
            name: "系统临时目录".to_string(),
            path: sys_temp.to_string_lossy().to_string(),
            cache_paths: vec![sys_temp.to_string_lossy().to_string()],
            size: get_dir_size(&sys_temp),
        });
    }
    let user_temp = std::env::temp_dir();
    system_items.push(TempItem {
        name: "用户临时目录".to_string(),
        path: user_temp.to_string_lossy().to_string(),
        cache_paths: vec![user_temp.to_string_lossy().to_string()],
        size: get_dir_size(&user_temp),
    });

    if !system_items.is_empty() {
        let total: u64 = system_items.iter().map(|i| i.size).sum::<u64>();
        categories.push(TempCategory {
            name: "系统与用户".to_string(),
            items: system_items,
            total_size: total,
        });
    }

    // 2. 动态扫描 LocalAppData (通常包含浏览器缓存、各种软件本地数据)
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        scan_app_data_category(PathBuf::from(local_app_data), &mut categories, "本地软件 (Local)");
    }

    // 3. 动态扫描 AppData Roaming (包含 VS Code, Npm 等配置及部分缓存)
    if let Ok(app_data) = std::env::var("APPDATA") {
        scan_app_data_category(PathBuf::from(app_data), &mut categories, "漫游软件 (Roaming)");
    }

    // 4. 社交软件扫描 (微信、QQ 等大容量数据目录)
    let mut social_items = Vec::new();
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        let doc_dir = PathBuf::from(user_profile).join("Documents");
        if doc_dir.exists() {
            // 微信
            let wechat_path = doc_dir.join("WeChat Files");
            if wechat_path.exists() {
                social_items.push(TempItem {
                    name: "微信数据 (WeChat)".to_string(),
                    path: wechat_path.to_string_lossy().to_string(),
                    cache_paths: vec![wechat_path.to_string_lossy().to_string()],
                    size: get_dir_size(&wechat_path),
                });
            }
            // QQ
            let qq_path = doc_dir.join("Tencent Files");
            if qq_path.exists() {
                social_items.push(TempItem {
                    name: "QQ 数据 (Tencent)".to_string(),
                    path: qq_path.to_string_lossy().to_string(),
                    cache_paths: vec![qq_path.to_string_lossy().to_string()],
                    size: get_dir_size(&qq_path),
                });
            }
        }
    }

    if !social_items.is_empty() {
        let total: u64 = social_items.iter().map(|i| i.size).sum::<u64>();
        categories.push(TempCategory {
            name: "社交软件 (Social)".to_string(),
            items: social_items,
            total_size: total,
        });
    }

    TempInfo { categories }
}

fn scan_app_data_category(base_path: PathBuf, categories: &mut Vec<TempCategory>, label: &str) {
    let mut items = Vec::new();
    let keywords = ["Cache", "Temp", "logs", "GPUCache", "Local Storage", "CachedData", "Code Cache", "Storage", "Webapps", "Webview2"];

    if let Ok(entries) = fs::read_dir(&base_path) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if !path.is_dir() { continue; }
            
            let folder_name = entry.file_name().to_string_lossy().to_string();
            // 过滤掉极其通用的 Windows 系统文件夹
            if folder_name == "Microsoft" || folder_name == "Packages" { continue; }

            let mut app_total_size: u64 = 0;
            let mut app_cache_paths = Vec::new();
            // 扫描此应用下的一级和二级目录寻找缓存
            find_caches_recursive(&path, &mut app_total_size, &mut app_cache_paths, &keywords, 0);

            if app_total_size > 1024 * 1024 { // 仅显示大于 1MB 的项以减少列表冗余
                items.push(TempItem {
                    name: folder_name,
                    path: path.to_string_lossy().to_string(),
                    cache_paths: app_cache_paths,
                    size: app_total_size,
                });
            }
        }
    }

    if !items.is_empty() {
        items.sort_by(|a, b| b.size.cmp(&a.size));
        let total: u64 = items.iter().map(|i| i.size).sum::<u64>();
        categories.push(TempCategory {
            name: label.to_string(),
            items,
            total_size: total,
        });
    }
}

fn find_caches_recursive(path: &PathBuf, total_size: &mut u64, found_paths: &mut Vec<String>, keywords: &[&str], depth: u8) {
    if depth > 2 { return; }

    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.filter_map(|e| e.ok()) {
            let p = entry.path();
            if !p.is_dir() { continue; }

            let name = entry.file_name().to_string_lossy().to_string();
            let is_match = keywords.iter().any(|&k| name.eq_ignore_ascii_case(k));

            if is_match {
                *total_size += get_dir_size(&p);
                found_paths.push(p.to_string_lossy().to_string());
            } else {
                find_caches_recursive(&p, total_size, found_paths, keywords, depth + 1);
            }
        }
    }
}

fn get_dir_size(path: &PathBuf) -> u64 {
    walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.metadata().ok())
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .sum::<u64>()
}

#[tauri::command]
async fn clean_temp_files(paths: Vec<String>) -> Result<u64, String> {
    let mut cleaned_size: u64 = 0;
    
    for path_str in paths {
        let path = PathBuf::from(&path_str);
        if !path.exists() { continue; }
        
        let meta = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };

        if meta.is_dir() {
            let entries = match fs::read_dir(&path) {
                Ok(read) => read.filter_map(|res| res.ok()).collect::<Vec<_>>(),
                Err(_) => continue,
            };

            for entry in entries {
                let p = entry.path();
                let size = get_dir_size(&p);
                if let Err(e) = force_delete_recursive(&p) {
                    println!("无法删除 {:?}: {}", p, e);
                } else {
                    cleaned_size += size;
                }
            }
        } else {
            let size = meta.len();
            if let Err(e) = force_delete_recursive(&path) {
                println!("无法删除 {:?}: {}", path, e);
            } else {
                cleaned_size += size;
            }
        }
    }

    Ok(cleaned_size)
}

#[tauri::command]
async fn start_full_scan(app: AppHandle, state: State<'_, Arc<AppState>>, target_path: String) -> Result<(), String> {
    let mut is_scanning = state.is_scanning.lock().unwrap();
    if *is_scanning {
        return Err("当前正在扫描中".to_string());
    }
    *is_scanning = true;

    state.folders.lock().unwrap().clear();
    state.file_count.store(0, Ordering::SeqCst);
    state.folder_count.store(0, Ordering::SeqCst);

    let state_arc = Arc::clone(&state);
    let app_clone = app.clone();
    let target_path_clone = target_path.clone();

    thread::spawn(move || {
        let app_progress = app_clone.clone();
        let state_progress = Arc::clone(&state_arc);
        
        let reporter = thread::spawn(move || {
            while *state_progress.is_scanning.lock().unwrap() {
                let _ = app_progress.emit("scan-progress", ScanProgress {
                    files_scanned: state_progress.file_count.load(Ordering::Relaxed),
                    folders_scanned: state_progress.folder_count.load(Ordering::Relaxed),
                });
                thread::sleep(Duration::from_millis(200));
            }
        });

        scan_recursive(PathBuf::from(&target_path_clone), &state_arc.folders, &state_arc.file_count, &state_arc.folder_count);

        *state_arc.is_scanning.lock().unwrap() = false;
        let _ = app_clone.emit("full-scan-finished", target_path_clone);
        let _ = reporter.join();
    });

    Ok(())
}

// 修改后的节点拉取，将文件和目录合并回前端展示格式
#[derive(Serialize, Clone)]
pub struct UIItem {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
}

#[tauri::command]
fn get_children(state: State<'_, Arc<AppState>>, parent_path: String) -> Result<Vec<UIItem>, String> {
    let folders = state.folders.lock().unwrap();
    let parent = folders.get(&parent_path).ok_or("找不到该路径")?;
    
    let mut results = Vec::new();
    
    // 添加子目录
    for sub_path in &parent.sub_folders {
        if let Some(folder) = folders.get(sub_path) {
            results.push(UIItem {
                path: sub_path.clone(),
                name: folder.name.clone(),
                size: folder.size,
                is_dir: true,
            });
        }
    }

    // 添加文件
    for file in &parent.files {
        results.push(UIItem {
            path: file.path.clone(),
            name: file.name.clone(),
            size: file.size,
            is_dir: false,
        });
    }

    // 按大小降序排序
    results.sort_by(|a, b| b.size.cmp(&a.size));
    Ok(results)
}

// 递归删除索引中的文件夹记录
fn remove_folder_index_recursive(folders: &mut HashMap<String, FolderNode>, path: &str) {
    if let Some(folder) = folders.remove(path) {
        for sub_path in folder.sub_folders {
            remove_folder_index_recursive(folders, &sub_path);
        }
    }
}

// 强制递归删除：处理 Windows 下的只读属性导致无法删除的问题
fn force_delete_recursive(path: &PathBuf) -> std::io::Result<()> {
    let metadata = fs::metadata(path)?;
    if metadata.is_dir() {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            force_delete_recursive(&entry.path())?;
        }
        // 处理目录本身的权限并删除
        let mut perms = metadata.permissions();
        perms.set_readonly(false);
        let _ = fs::set_permissions(path, perms);
        fs::remove_dir(path)?;
    } else {
        // 处理文件权限并删除
        let mut perms = metadata.permissions();
        perms.set_readonly(false);
        let _ = fs::set_permissions(path, perms);
        fs::remove_file(path)?;
    }
    Ok(())
}

#[tauri::command]
fn delete_path(state: State<'_, Arc<AppState>>, path: String, is_dir: bool) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);

    // 1. 从物理磁盘尝试强制删除
    if let Err(e) = force_delete_recursive(&path_buf) {
       let err_msg = e.to_string();
       if e.kind() == std::io::ErrorKind::PermissionDenied {
           return Err(format!("清理失败：拒绝访问 ({})。请确保：\n1. 文件或文件夹未被其他程序（如资源管理器、编辑器）占用。\n2. 尝试以管理员身份运行此应用。", err_msg));
       }
       return Err(format!("清理过程中出现未知错误: {}", err_msg));
    }

    // 2. 更新后端索引
    let mut folders = state.folders.lock().unwrap();
    
    // 获取父目录路径
    let path_buf = PathBuf::from(&path);
    if let Some(parent_path) = path_buf.parent().map(|p| p.to_string_lossy().to_string()) {
        if let Some(parent_node) = folders.get_mut(&parent_path) {
            let mut item_size = 0;

            if is_dir {
                // 如果是目录，从父目录的 sub_folders 中移除
                if let Some(pos) = parent_node.sub_folders.iter().position(|x| x == &path) {
                    parent_node.sub_folders.remove(pos);
                    // 获取被删除目录的大小以供扣除
                    if let Some(deleted_node) = folders.get(&path) {
                        item_size = deleted_node.size;
                    }
                }
            } else {
                // 如果是文件，从父目录的 files 中移除
                if let Some(pos) = parent_node.files.iter().position(|x| x.path == path) {
                    let file = parent_node.files.remove(pos);
                    item_size = file.size;
                }
            }

            // 更新父目录及祖先目录的大小
            if item_size > 0 {
                let mut current_p = Some(parent_path);
                while let Some(p_path) = current_p {
                    if let Some(node) = folders.get_mut(&p_path) {
                        node.size = node.size.saturating_sub(item_size);
                        // 继续向上找父目录
                        let current_buf = PathBuf::from(&p_path);
                        current_p = current_buf.parent().map(|p| p.to_string_lossy().to_string());
                    } else {
                        current_p = None;
                    }
                }
            }
        }
    }

    // 3. 如果是目录，递归清理该目录下所有子目录的索引
    if is_dir {
        remove_folder_index_recursive(&mut folders, &path);
    }

    Ok(())
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    opener::open(path).map_err(|e| e.to_string())
}

pub fn run() {
    let state = Arc::new(AppState {
        folders: Mutex::new(HashMap::new()),
        is_scanning: Mutex::new(false),
        file_count: AtomicU64::new(0),
        folder_count: AtomicU64::new(0),
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_drives, 
            start_full_scan, 
            get_children,
            delete_path,
            get_temp_info,
            clean_temp_files,
            open_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
