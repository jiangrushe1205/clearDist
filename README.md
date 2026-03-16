# ClearDist - 稳定磁盘分析与清理工具

ClearDist 是一款基于 **Tauri + React + Rust** 构建的高性能本地磁盘空间分析与清理工具。它采用多线程并行扫描技术，不仅扫描速度极快，更在处理超大规模文件系统时具备卓越的稳定性，有效防止因文件过多导致的界面卡死或内存溢出。

## ✨ 核心特性

- **🚀 极速扫描**：核心逻辑由 Rust 驱动，利用 `Rayon` 进行多线程并行解析，充分榨干 CPU 多核性能。
- **🛡️ 稳定可靠**：采用后端索引、前端按需拉取的架构，支持数十万甚至上百万级别的文件扫描而不崩溃。
- **📊 占比可视化**：树形目录结构配合空间占比直观显示，帮助您快速定位磁盘中的“空间杀手”。
- **🧹 一键清理**：支持直接从应用内删除无用文件或文件夹，释放存储空间。
- **💻 跨平台体验**：基于 Tauri 2.0，提供原生桌面级性能与现代化的 UI 交互。

## 🛠️ 技术栈

- **Frontend**: React 19, Vite, TypeScript
- **Backend**: Rust, Tauri 2.0
- **Parallelism**: Rayon (Rust 多线程数据处理库)
- **System Info**: `sysinfo` (跨平台系统信息采集)

## 🚀 快速开始

### 前置要求

在开始之前，请确保您的开发环境已安装：
- [Node.js](https://nodejs.org/) (建议最新 LTS 版本)
- [Rust](https://www.rust-lang.org/learn/get-started) (编译后端代码)
- [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (Windows 用户通常已内置)

### 安装与运行

1. **克隆项目**
   ```bash
   git clone <project-url>
   cd clearDist
   ```

2. **安装依赖**
   ```bash
   npm install
   ```

3. **启动开发环境**
   ```bash
   npm run tauri dev
   ```

4. **构建正式版本**
   ```bash
   npm run tauri build
   ```

## 📂 项目结构

```text
├── src/               # 前端 React 源代码
│   ├── App.tsx        # 核心交互逻辑与文件树渲染
│   └── main.tsx       # 入口文件
├── src-tauri/         # Rust 后端源代码
│   ├── src/lib.rs     # 磁盘扫描核心逻辑、多线程实现
│   └── tauri.conf.json # Tauri 配置文件
└── package.json       # 项目依赖与脚本
```

## 📝 推荐 IDE 配置

- [VS Code](https://code.visualstudio.com/)
- [Tauri 扩展](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
- [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
69: 
70: ## 📜 开源协议
71: 
72: 本项目采用 [MIT License](LICENSE) 协议。
