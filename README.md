# xShell Lite

一个仿照 Xshell 制作的跨平台 SSH 终端客户端，基于 **Electron + xterm.js + ssh2** 构建，可在 Windows / macOS / Linux 上运行。

## 功能

- SSH 连接终端，支持颜色、光标、滚动缓冲区（基于 xterm.js）
- 会话管理：保存主机、端口、用户名、认证方式，点击即连
- 两种认证方式：密码 / 私钥（含口令）
- 多标签页，可同时打开多个 SSH 会话
- 终端随窗口自适应大小（自动向服务器发送 resize）
- 主机密钥指纹校验：首次连接需确认，密钥变化会警告（防中间人攻击）
- 密码/口令使用系统密钥链加密存储（Electron `safeStorage`），不会明文落盘（在系统提供密钥链的平台上）

## 目录结构

```
xshell-clone/
├── electron/
│   ├── main.js       # 主进程：窗口、会话存储、SSH 连接(ssh2)、IPC
│   └── preload.js    # 预加载脚本，通过 contextBridge 暴露安全 API
├── src/
│   ├── index.html    # 界面结构
│   ├── style.css      # 深色主题样式
│   └── renderer.js   # 渲染进程逻辑：会话列表、标签页、终端交互
├── package.json
└── build/            # 打包资源目录（可放应用图标 icon.ico / icon.icns / icon.png）
```

## 本地运行

```bash
npm install
npm start
```

首次启动后，点击左侧“＋”新建一个会话，填写主机、端口、用户名和密码（或私钥），点击“保存并连接”即可。

## 打包成安装包

使用 [electron-builder](https://www.electron.build/)：

```bash
npm run build:win     # Windows 安装包 (nsis)
npm run build:mac     # macOS 安装包 (dmg，需在 macOS 上执行)
npm run build:linux   # Linux 安装包 (AppImage)
npm run build         # 尝试三平台一起打包（通常需要在对应平台或 CI 上运行）
```

生成的安装包在 `release/` 目录下。

> 提示：在 `build/` 目录放入 `icon.ico`（Windows）、`icon.icns`（macOS）、`icon.png`（Linux，建议 512x512）可以自定义应用图标；不放的话会使用 Electron 默认图标。

## 关于安全性

- 密码/私钥口令通过 `safeStorage` 加密后存储在应用数据目录的 `sessions.json` 中；如果操作系统未提供可用的加密后端，会退化为明文存储（仅用于开发/测试，生产使用建议确保系统密钥链可用）。
- 主机公钥指纹会记录在应用数据目录的 `known_hosts.json` 中，逻辑类似 OpenSSH 的 `known_hosts`。
- 私钥文件本身不会被复制，只在连接时读取其路径指向的文件。

## 已知限制 / 后续可扩展方向

当前版本聚焦于「终端 + 会话管理」这一核心体验，以下是 Xshell 中有、但本项目暂未实现的功能，可在此基础上继续扩展：

- SFTP 文件传输（类似 Xshell 自带的 Xftp）
- 终端外观自定义（配色方案、字体大小、快捷键）
- 会话录制/日志导出
- 端口转发 / 隧道
- 会话分组、搜索

## 技术栈

- [Electron](https://www.electronjs.org/)
- [xterm.js](https://xtermjs.org/)（`@xterm/xterm` + `@xterm/addon-fit`）
- [ssh2](https://github.com/mscdex/ssh2)（Node.js SSH2 客户端实现）
