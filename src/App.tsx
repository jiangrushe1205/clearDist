import { useState, useEffect, useMemo, useCallback } from "react";
import "./App.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// 预定义数据类型
type DriveInfo = {
  letter: string;
  name: string;
  total_space: number;
  available_space: number;
};

type FileNode = {
  path: string;
  name: string;
  size: number;
  is_dir: boolean;
  children: string[];
};

type FileItem = FileNode & {
  depth: number;
  parentId: string | null;
  isExpanded?: boolean;
};

type ScanProgress = {
  files_scanned: number;
  folders_scanned: number;
};

function formatSize(bytes: number) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

const FileRow = ({ 
  item, 
  percent, 
  onToggle, 
  onDelete 
}: { 
  item: FileItem; 
  percent: number; 
  onToggle: (item: FileItem) => void; 
  onDelete: (item: FileItem) => void;
}) => {
  return (
    <div key={item.path} className="file-row">
      <div 
        className="file-info" 
        style={{ 
          paddingLeft: `${item.depth * 24}px`,
          cursor: item.is_dir ? 'pointer' : 'default'
        }}
        onClick={() => item.is_dir && onToggle(item)}
      >
        {item.is_dir ? (
          <div className="expand-icon">
            {item.isExpanded ? "−" : "+"}
          </div>
        ) : (
          <div style={{ width: '20px' }} />
        )}
        <span className="file-icon" style={{ pointerEvents: 'none' }}>
          {item.is_dir ? "📁" : "📄"}
        </span>
        <span className="file-name" title={item.path} style={{ pointerEvents: 'none' }}>
          {item.name || item.path}
        </span>
      </div>
      
      <div style={{ textAlign: 'right', fontWeight: 600, color: 'var(--accent-hover)' }}>
         {formatSize(item.size)}
      </div>

      <div className="percentage-cell">
        <div 
          className="percentage-fill" 
          style={{ width: `${Math.max(1, Math.min(100, percent))}%` }} 
        />
        <span className="percentage-text">
          {percent.toFixed(1)}%
        </span>
      </div>

      <div style={{ textAlign: 'center' }}>
        <button 
          className="btn-mini" 
          onClick={(e) => {
            e.stopPropagation();
            onDelete(item);
          }}
        >
          清理
        </button>
      </div>
    </div>
  );
};

function App() {
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [selectedDrive, setSelectedDrive] = useState<string | null>(null);
  
  const [flatTree, setFlatTree] = useState<FileItem[]>([]);
  const [isAnyLoading, setIsAnyLoading] = useState(false);
  const [progress, setProgress] = useState({ files: 0, folders: 0 });

  // 初始化磁盘
  useEffect(() => {
    async function fetchDrives() {
      try {
        const result: DriveInfo[] = await invoke("get_drives");
        const validDrives = result.filter(d => d.total_space > 0);
        setDrives(validDrives);
        if (validDrives.length > 0) setSelectedDrive(validDrives[0].letter);
      } catch (error) { console.error(error); }
    }
    fetchDrives();
  }, []);

  // 监听全量扫描事件
  useEffect(() => {
    const unProg = listen<ScanProgress>("scan-progress", (event) => {
      setProgress({ 
        files: event.payload.files_scanned, 
        folders: event.payload.folders_scanned 
      });
    });

    const unFinish = listen<string>("full-scan-finished", async (event) => {
      const rootPath = event.payload;
      try {
        // 扫描结束后，从后端缓存中拉取第一层结果
        const children: FileNode[] = await invoke("get_children", { parentPath: rootPath });
        const initialItems: FileItem[] = children.map(node => ({
           ...node,
           depth: 0,
           parentId: rootPath,
           isExpanded: false
        }));
        setFlatTree(initialItems);
      } catch (e) {
        console.error("加载根目录失败", e);
      }
      setIsAnyLoading(false);
    });

    return () => {
      unProg.then(f => f());
      unFinish.then(f => f());
    };
  }, []);

  const handleInitialScan = async () => {
    if (!selectedDrive) return;
    setIsAnyLoading(true);
    setProgress({ files: 0, folders: 0 });
    setFlatTree([]);

    try {
      await invoke("start_full_scan", { targetPath: selectedDrive });
    } catch (err) { 
      alert("扫描失败: " + err);
      setIsAnyLoading(false);
    }
  };

  const toggleExpand = useCallback(async (item: FileItem) => {
    if (!item.is_dir) return;

    if (item.isExpanded) {
      // 收起阶段
      setFlatTree(prev => {
        const idx = prev.findIndex(f => f.path === item.path);
        const newTree = [...prev];
        newTree[idx] = { ...item, isExpanded: false };
        
        let i = idx + 1;
        while (i < newTree.length && newTree[i].depth > item.depth) {
          i++;
        }
        newTree.splice(idx + 1, i - (idx + 1));
        return newTree;
      });
    } else {
      // 展开阶段：从后端内存拉取
      try {
        const children: FileNode[] = await invoke("get_children", { parentPath: item.path });
        const subItems: FileItem[] = children.map(child => ({
           ...child,
           depth: item.depth + 1,
           parentId: item.path,
           isExpanded: false
        }));

        setFlatTree(prev => {
          const idx = prev.findIndex(f => f.path === item.path);
          if (idx === -1) return prev;
          const newTree = [...prev];
          newTree[idx] = { ...item, isExpanded: true };
          newTree.splice(idx + 1, 0, ...subItems);
          return newTree;
        });
      } catch (e) {
        console.error("展开目录失败", e);
      }
    }
  }, []);

  const handleDelete = useCallback(async (item: FileItem) => {
    if (!confirm(`确认清理 ${item.name}？`)) return;
    try {
      await invoke("delete_path", { path: item.path, isDir: item.is_dir });
      setFlatTree(prev => prev.filter(f => f.path !== item.path));
    } catch (err) { alert("清理失败: " + err); }
  }, []);

  const treeWithPercents = useMemo(() => {
    const parentSizes = new Map<string, number>();
    flatTree.forEach(item => {
        if (item.is_dir) parentSizes.set(item.path, item.size);
    });

    return flatTree.map(item => {
      let percent = 0;
      if (item.depth === 0) {
        const drive = drives.find(d => selectedDrive?.startsWith(d.letter));
        if (drive) {
          const used = drive.total_space - drive.available_space;
          percent = used > 0 ? (item.size / used) * 100 : 0;
        }
      } else if (item.parentId) {
        // 由于是全量索引后的数据，父目录大小已确定
        const pSize = parentSizes.get(item.parentId);
        if (pSize && pSize > 0) percent = (item.size / pSize) * 100;
      }
      return { item, percent };
    });
  }, [flatTree, drives, selectedDrive]);

  return (
    <>
      <div className="titlebar">
        <div className="titlebar-text">ClearFile - 稳定索引专家</div>
      </div>
      <div className="app-container">
        <aside className="sidebar">
          <h2>存储设备</h2>
          <ul className="drive-list">
            {drives.map((drive) => (
              <li 
                key={drive.letter} 
                className={`drive-item ${selectedDrive === drive.letter ? 'active' : ''}`}
                onClick={() => !isAnyLoading && setSelectedDrive(drive.letter)}
              >
                <span className="drive-icon">💾</span>
                <div>
                  <div className="drive-name">{drive.name} ({drive.letter})</div>
                  <div className="drive-status">
                    空闲: {(drive.available_space / 1024**3).toFixed(1)}GB
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </aside>

        <main className="main-content">
          <div className="header">
             <div className="header-flex">
               <h1>全量磁盘快照 (稳定版)</h1>
               <button className="btn-primary" onClick={handleInitialScan} disabled={isAnyLoading}>
                 {isAnyLoading ? "正在扫描系统文件..." : "🚀 开始全盘分析"}
               </button>
            </div>
          </div>

          <div className="content-body" style={{ padding: 0 }}>
            {isAnyLoading && flatTree.length === 0 ? (
              <div className="loading-state">
                <div className="loading-spinner"></div>
                <p>正在后台建立稳定索引，防止大数据溢出...</p>
                <div className="counter-box">
                   <div className="counter-number">{(progress.files + progress.folders).toLocaleString()}</div>
                   <div className="counter-label">文件索引已入库</div>
                   <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '8px' }}>
                     数据驻留后端内存，前端轻量化拉取
                   </div>
                </div>
              </div>
            ) : flatTree.length > 0 ? (
              <div className="results-view">
                <div className="list-header">
                  <div>目录 / 文件</div>
                  <div style={{ textAlign: 'right' }}>大小</div>
                  <div>占比</div>
                  <div style={{ textAlign: 'center' }}>操作</div>
                </div>
                <div className="file-list">
                  {treeWithPercents.map(({ item, percent }) => (
                    <FileRow 
                      key={item.path}
                      item={item}
                      percent={percent}
                      onToggle={toggleExpand}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-icon">🛡️</div>
                <p>安全全量分析：不再因文件过多而崩溃</p>
              </div>
            )}
          </div>
        </main>
      </div>
    </>
  );
}

export default App;
