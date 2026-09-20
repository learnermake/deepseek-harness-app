# DeepSeek Harness 桌面应用（Electron 外壳）

把 DeepSeek Harness 的 Web GUI 封装成一个可分发的 Windows 桌面应用。

**设计核心：外壳与 harness 解耦。** 应用只依赖 `dsh web` 这个稳定的 CLI 契约（`--port` / `--no-open` / 打印登录 URL），
不 import harness 内部代码。因此 harness 可以独立升级、回滚，不需要重发应用。

```
DeepSeek Harness.exe (Electron, asar)
  └─ spawn <bundled node> <harness tree>/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 0 --no-open
       → 从 stdout 抓 "dsh web: http://127.0.0.1:<port>/?token=..." 登录地址
       → BrowserWindow.loadURL(该地址)
       → 应用退出时 SIGTERM 回收子进程

%APPDATA%\DeepSeekHarness\
  ├─ harness\
  │   ├─ 0.1.5-rc.2\       当前使用的版本树（完整依赖）
  │   ├─ <其他版本>\        上一个版本（回滚用）
  │   └─ current.json      {"current":"...","previous":"...","bundled":"..."}
  ├─ logs\                 应用与 harness 服务日志
  └─ settings.json         workspace / port / registry
```

## 分发形态

| 目标 | 说明 |
| --- | --- |
| NSIS 向导安装包（约 164MB） | 安装时可**自定义安装目录**；每用户安装（装 Program Files 时自动提权）；卸载默认**保留** `%APPDATA%` 缓存，弹窗询问后才删除 |
| portable（约 164MB） | 免安装单目录，放 U 盘即可运行 |

随包内容（都以压缩形态分发，首次运行才释放到 `%APPDATA%`）：

| 资源 | 形态 | 大小 |
| --- | --- | --- |
| harness 首发版本树 | `harness-bundle.tar.gz` → 首次运行解包 | 归档 48.8MB / 解开 213MB（25452 文件） |
| node 运行时 + npm | `resources/node/{node.exe,npm}` | 110MB |

> harness 为什么用 tar 而不是目录：electron-builder 会把 `extraResources` 里的 `node_modules` 目录整个过滤掉
> （实测直接指目录，打进去只剩 3 个文件）。npm 同理，被刻意放在 `node-runtime/npm` 而非 `node_modules` 下。

## 两条互不影响的更新通道

1. **harness 版本**（设置面板里）：查 registry → 装到临时目录 → 冒烟校验 → 就位到 `%APPDATA%\...\harness\<版本>\` → 切指针 → 只重启 harness 子进程。
   保留"当前 + 上一个"两棵树（回滚用），切换成功后自动清理更旧的（每棵树可能几百 MB）。
2. **应用本体**：`electron-updater`，需要发布源（见 `electron-builder.config.cjs` 里的 `publish`，目前是注释占位）。
   未配置时设置面板会明确提示"更新源尚未配置"，不会静默失败。

## 实测数据

| 项目 | 结果 |
| --- | --- |
| 首次运行解包 | 28,743 条目 → 25,452 文件 / 213MB，约 25 秒 |
| 冷启动自检（已就绪状态） | 8.4 秒 PASS |
| 打包后 portable 首启 | 32.4 秒，解包 25,452 文件，PASS |
| harness 升级到 alpha 通道 | `0.1.6-alpha.2` 暂存 156 秒 / 26518 文件 / **550MB**（依赖版本错配导致 npm 嵌套复制，故有上面的清理策略） |
| 停机 | SIGTERM → 整棵树退出，**零孤儿进程** |

## 开发

```bash
npm install                     # 装 Electron 与打包工具
npm run smoke                   # 无人值守自检：启 harness → 健康校验 → 自动退出（不开窗口）
npm start                       # 正常启动 GUI
node probe/updater-probe.cjs     # 单独验证更新通道的版本查询
node probe/smoke-test.mjs harness-bundle   # 验证一棵依赖树是否可用
```

`--smoke` 的判定链：node 运行时解析 → harness 版本树可用 → 服务起来并打印登录 URL → 浏览器式请求拿到 303 → 优雅停机零孤儿。

## 打包

```bash
node scripts/create-bundle.mjs              # 重新生成内置 harness（默认 pin 0.1.5-rc.2）
node scripts/create-bundle.mjs 0.1.6-alpha.2
npm run dist                                # NSIS + portable
npm run dist:portable
```

国内网络下如果 electron-builder 下载 NSIS 工具链超时，设镜像：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/'
```

## 发布 Release（重要细节）

仓库：https://github.com/learnermake/deepseek-harness-app （`publish` 已配好）

```powershell
npm run dist                       # 先出产物
gh release create v0.1.0 --title "..." --notes-file .release-notes.md `
  "dist/DeepSeek-Harness-0.1.0-x64.exe" `
  "dist/DeepSeek Harness-0.1.0-portable.exe" `
  "dist/latest.yml"
```

三个必须注意的点，否则自动更新会静默失效：

1. **必须一并上传 `dist/latest.yml`** —— 它是 electron-updater 的版本清单，缺了它客户端查不到更新。
2. **`latest.yml` 里引用的文件名用连字符**（`DeepSeek-Harness-0.1.0-x64.exe`），
   而 GitHub 会把上传文件名里的空格规范化成点号。所以要么按连字符名重新上传一份
   （`Copy-Item` 改名后再 `gh release upload`），要么把 `artifactName` 改成不含空格的写法。
   两种名字对不上时，客户端会下载 404。
3. **不要用 PowerShell 重定向保存 gh 的 JSON 输出**（会写 UTF-8 BOM，Node 的 `JSON.parse` 直接报错）。
   用 `gh --jq`，或显式用无 BOM 编码写文件。

## 踩过的坑（都已在代码里处理）

### 1. DSH Web 有进程级 token 门禁
裸访问 `http://127.0.0.1:3080/` 返回 **401**；必须用服务打印的 `http://127.0.0.1:3080/?token=...`。
token 每次启动都变、且是进程私有的，外部伪造不了——所以外壳必须从 stdout 抓取。

### 2. 健康检查只看 fetch 的返回值会误判
服务按"请求意图"发 cookie：

| 请求 | 结果 |
| --- | --- |
| 默认头（`Accept: */*`） | 401 |
| 带 `Accept: text/html` 或浏览器 UA | **303 + set-cookie** |
| 裸 origin（无 token） | 401 |

健康校验因此必须带 HTML Accept，且以 303 为通过标准。

### 3. Electron 主进程里 `process.execPath` 是 electron.exe
直接拿它 spawn 会再起一个 Electron 实例（表现为"服务起来但永远不就绪"）。
`resolveNodeRuntime()` 的优先级：随包 node → `DSH_NODE_PATH` → PATH → `ELECTRON_RUN_AS_NODE=1` 兜底。

### 4. harness 依赖树必须以"包装项目"形态安装
根目录只能依赖 `@deepseek-ai/dsh` 一个包。直接把 dsh 包当根项目，会把它的 72 个运行时依赖当生产依赖解析，
其中 `@deepseek-ai/dsh-experimental-code-runtime-python` **在 npm 上不存在（404）**，安装必然失败。

### 5. 安装参数不能乱加
- **不能加 `--omit=optional`**：koffi 的原生模块在可选依赖 `@koromix/koffi-win32-x64` 里，
  省掉它运行时会抛 `Cannot find the native Koffi module`（沙箱、进程、JSONL 持久化都依赖 koffi）。
- **必须加 `--ignore-scripts`**：koffi 的 install 脚本在没装 CMake 的机器上直接失败；
  而预编译二进制已由上面的平台包提供，无需构建。

正确组合：`npm install --omit=dev --ignore-scripts`（包装项目形态）。

### 6. Node 的 fetch 在 IPv6 不通的机器上会连接超时
本机 `fetch('https://registry.npmjs.org/...')` 报 `Connect Timeout`，而 `https.get` 正常。
原因是 undici 优先尝试 IPv6。`src/main/https.js` 显式 `family: 4` 解决；更新检查与健康校验都走它。

### 7. 控制台窗口的根源
`powershell` / `cmd` / `node` 都是 console 子系统，宿主必然带一个 conhost；
关掉那个窗口就会带走服务。Electron 是 GUI 子系统，从根上没有这个问题（spawn 时仍加 `windowsHide: true`）。

### 8. Windows PowerShell 5.1 按 ANSI 读无 BOM 的 UTF-8
带中文的 `.ps1` 必须存成 **UTF-8 带 BOM**，否则中文注释会导致语法错误。

### 9. .mjs 里不能写 require
`scripts/pack-bundle.mjs` 最初误用 CommonJS，报 `require is not defined in ES module scope`。
`.mjs` 一律用 `import`。

### 10. npm 安装大依赖树需要放宽重试
默认 `--fetch-retries=2` / `--fetch-timeout=300s` 在这棵 500+ 包的树上不够（实测撞过 `ECONNRESET`）。
更新器已加 `--fetch-retries=5 --fetch-retry-maxtimeout=60000 --fetch-timeout=900000`。

### 11. electron-builder 下载 NSIS 工具链会超时
GitHub 直连不稳定时（`connect ETIMEDOUT ...:443`），设镜像：
`ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/`

## 文件说明

| 路径 | 作用 |
| --- | --- |
| `src/main/index.js` | 主进程：窗口 + 生命周期 + IPC + `--smoke` |
| `src/main/harness-server.js` | harness 子进程：spawn / 抓 URL / 健康校验 / 优雅停机 |
| `src/main/settings.js` | 设置读写 + 版本指针 + 首次运行释放内置 harness |
| `src/main/harness-updater.js` | harness 更新通道（查版本 / 暂存安装 / 校验 / 切换） |
| `src/main/paths.js` | 路径常量 + node 运行时解析 |
| `src/main/https.js` | 强制 IPv4 的 HTTP 客户端 |
| `src/preload/index.js` | contextBridge 暴露的最小 API |
| `src/renderer/*` | 启动/错误覆盖层 + 设置面板 |
| `build/installer.nsh` | 卸载时询问是否删除缓存数据 |
| `scripts/create-bundle.mjs` | 生成内置 harness 版本树 |
| `probe/*` | 关键风险的独立验证脚本 |
