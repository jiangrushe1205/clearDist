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

    let mut total_size: u64 = current_files.iter().map(|f| f.size).sum();
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

#[tauri::command]
fn delete_path(state: State<'_, Arc<AppState>>, path: String, is_dir: bool) -> Result<(), String> {
    if is_dir {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
        state.folders.lock().unwrap().remove(&path);
    } else {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
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
            delete_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
