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

type TempItem = {
  name: string;
  path: string;
  cache_paths: string[];
  size: number;
};

type TempCategory = {
  name: string;
  items: TempItem[];
  total_size: number;
};

type TempInfo = {
  categories: TempCategory[];
};

function formatSize(bytes: number) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

type ModalProps = {
  isOpen: boolean;
  title: string;
  message: string;
  type: 'confirm' | 'alert' | 'error';
  onConfirm: () => void;
  onCancel?: () => void;
};

const Modal = ({ isOpen, title, message, type, onConfirm, onCancel }: ModalProps) => {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onCancel || onConfirm}>
      <div className={`modal-content ${type}`} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-icon">
            {type === 'confirm' ? '🛡️' : type === 'error' ? '⚠️' : '✨'}
          </div>
          <h3>{title}</h3>
        </div>
        <div className="modal-body">
          <p>{message}</p>
        </div>
        <div className="modal-footer">
          {type === 'confirm' && (
            <button className="btn-secondary" onClick={onCancel}>
              稍后再说
            </button>
          )}
          <button className={`btn-${type === 'error' ? 'danger' : 'primary'}`} onClick={onConfirm}>
            {type === 'confirm' ? '立即清理' : '确定'}
          </button>
        </div>
      </div>
    </div>
  );
};

const FileRow = ({
  item,
  percent,
  onToggle,
  onDelete,
  isDeleting
}: {
  item: FileItem;
  percent: number;
  onToggle: (item: FileItem) => void;
  onDelete: (item: FileItem) => void;
  isDeleting: boolean;
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
          className={`btn-mini ${isDeleting ? 'loading' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            if (!isDeleting) onDelete(item);
          }}
          disabled={isDeleting}
        >
          {isDeleting ? "正在清理..." : "清理"}
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
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [progress, setProgress] = useState({ files: 0, folders: 0 });

  const [viewMode, setViewMode] = useState<'drive' | 'quick'>('drive');
  const [tempInfo, setTempInfo] = useState<TempInfo | null>(null);
  const [cleaningTemp, setCleaningTemp] = useState(false);

  const [modalConfig, setModalConfig] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    type: 'confirm' | 'alert' | 'error';
    onConfirm: () => void;
    onCancel?: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    type: 'alert',
    onConfirm: () => { },
  });

  const showAlert = (title: string, message: string, type: 'alert' | 'error' = 'alert') => {
    setModalConfig({
      isOpen: true,
      title,
      message,
      type,
      onConfirm: () => setModalConfig(prev => ({ ...prev, isOpen: false })),
    });
  };

  const showConfirm = (title: string, message: string, onConfirm: () => void) => {
    setModalConfig({
      isOpen: true,
      title,
      message,
      type: 'confirm',
      onConfirm: () => {
        onConfirm();
        setModalConfig(prev => ({ ...prev, isOpen: false }));
      },
      onCancel: () => setModalConfig(prev => ({ ...prev, isOpen: false })),
    });
  };

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
      showAlert("扫描失败", String(err), "error");
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
    showConfirm("确认清理", `您确定要清理 "${item.name}" 吗？此操作无法撤销。`, async () => {
      setDeletingPath(item.path);
      try {
        await invoke("delete_path", { path: item.path, isDir: item.is_dir });

        setFlatTree(prev => {
          let newTree = prev.filter(f => !f.path.startsWith(item.path));
          const deletedSize = item.size;
          newTree = newTree.map(f => {
            if (item.path.startsWith(f.path) && f.path !== item.path) {
              return { ...f, size: Math.max(0, f.size - deletedSize) };
            }
            return f;
          });
          return newTree;
        });
      } catch (err) {
        showAlert("清理失败", String(err), "error");
      } finally {
        setDeletingPath(null);
      }
    });
  }, [showConfirm, showAlert]);

  const handleTempScan = async () => {
    setViewMode('quick');
    setIsAnyLoading(true);
    try {
      const info: TempInfo = await invoke("get_temp_info");
      setTempInfo(info);
    } catch (err) {
      showAlert("获取临时文件失败", String(err), "error");
    } finally {
      setIsAnyLoading(false);
    }
  };

  const handleCleanTemp = async (paths: string[]) => {
    showConfirm("确认清理", `确定要清理选中的临时文件吗？`, async () => {
      setCleaningTemp(true);
      try {
        const cleaned: number = await invoke("clean_temp_files", { paths });
        showAlert("清理完成", `成功释放了 ${formatSize(cleaned)} 空间`);
        // 刷新信息
        const info: TempInfo = await invoke("get_temp_info");
        setTempInfo(info);
      } catch (err) {
        showAlert("清理失败", String(err), "error");
      } finally {
        setCleaningTemp(false);
      }
    });
  };

  const handleOpenPath = async (path: string) => {
    try {
      await invoke("open_path", { path });
    } catch (err) {
      showAlert("打开目录失败", String(err), "error");
    }
  };

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
                onClick={() => {
                  if (!isAnyLoading) {
                    setSelectedDrive(drive.letter);
                    setViewMode('drive');
                  }
                }}
              >
                <span className="drive-icon">💾</span>
                <div>
                  <div className="drive-name">{drive.name} ({drive.letter})</div>
                  <div className="drive-status">
                    空闲: {(drive.available_space / 1024 ** 3).toFixed(1)}GB
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <h2 style={{ marginTop: '32px' }}>实用工具</h2>
          <div
            className={`drive-item ${viewMode === 'quick' ? 'active' : ''}`}
            onClick={() => !isAnyLoading && handleTempScan()}
          >
            <span className="drive-icon">🧹</span>
            <div>
              <div className="drive-name">快速清理</div>
              <div className="drive-status">临时文件与缓存</div>
            </div>
          </div>
        </aside>

        <main className="main-content">
          <div className="header">
            <div className="header-flex">
              <h1>{viewMode === 'drive' ? '全量磁盘快照 (稳定版)' : '快速清理 (临时文件)'}</h1>
              {viewMode === 'drive' ? (
                <button className="btn-primary" onClick={handleInitialScan} disabled={isAnyLoading}>
                  {isAnyLoading ? "正在扫描系统文件..." : "🚀 开始全盘分析"}
                </button>
              ) : (
                <button
                  className="btn-primary"
                  onClick={() => handleCleanTemp(tempInfo?.categories.flatMap(c => c.items.flatMap(i => i.cache_paths)) || [])}
                  disabled={isAnyLoading || cleaningTemp || !tempInfo || tempInfo.categories.every(c => c.total_size === 0)}
                >
                  {cleaningTemp ? "正在清理中..." : "🧹 一键清理全部"}
                </button>
              )}
            </div>
          </div>

          <div className="content-body" style={{ padding: 0 }}>
            {isAnyLoading && viewMode === 'drive' && flatTree.length === 0 ? (
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
            ) : viewMode === 'drive' && flatTree.length > 0 ? (
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
                      isDeleting={deletingPath === item.path}
                    />
                  ))}
                </div>
              </div>
            ) : viewMode === 'quick' ? (
              <div className="results-view">
                {isAnyLoading ? (
                  <div className="loading-state">
                    <div className="loading-spinner"></div>
                    <p>正在分析临时文件...</p>
                  </div>
                ) : tempInfo ? (
                  <div className="temp-view">
                    {tempInfo.categories.map((cat) => (
                      <div key={cat.name} className="temp-category-section">
                        <div className="category-header">
                          <span className="category-name">{cat.name}</span>
                          <span className="category-size">{formatSize(cat.total_size)}</span>
                          <button
                            className="btn-mini-text"
                            onClick={() => handleCleanTemp(cat.items.flatMap(i => i.cache_paths))}
                            disabled={cleaningTemp || cat.total_size === 0}
                          >
                            清理此项
                          </button>
                        </div>
                        <div className="category-items">
                          {cat.items.map(item => (
                            <div key={item.path} className="temp-item-row">
                              <span className="item-name" title={item.name}>{item.name}</span>
                              <span className="item-path" title={item.path}>{item.path}</span>
                              <div className="item-actions">
                                <span className="item-size">{formatSize(item.size)}</span>
                                <button
                                  className="btn-action-mini"
                                  onClick={() => handleOpenPath(item.path)}
                                  title="打开目录"
                                >
                                  📂
                                </button>
                                <button
                                  className="btn-action-mini danger"
                                  onClick={() => handleCleanTemp(item.cache_paths)}
                                  disabled={cleaningTemp || item.size === 0}
                                  title="清理此项"
                                >
                                  🗑️
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-icon">🛡️</div>
                <p>{viewMode === 'drive' ? '安全全量分析：不再因文件过多而崩溃' : '点击“一键清理”释放空间'}</p>
              </div>
            )}
          </div>
        </main>
      </div>
      <Modal {...modalConfig} />
    </>
  );
}

export default App;
