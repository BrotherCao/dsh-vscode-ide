# dsh-vscode-ide

在 **DeepSeek Harness** 的右侧边栏里跑一个**真的 VS Code**（不是迷你编辑器、不是只读高亮），
左边聊天、右边看代码改代码 —— 也就是「以 DSH 为主体、VS Code 作为被嵌进去的 IDE」，
和 VS Code 自带 AI 侧边栏的方向正好反过来。

```
┌──────────────┬────────────────────────────────────┬──────────────────┐
│ DSH 会话      │  对话 / 工具调用                    │  代码 (VS Code)   │
│ 列表          │                                    │  资源管理器/编辑器  │
└──────────────┴────────────────────────────────────┴──────────────────┘
```

## 它是怎么做到的

1. **host 半端**（`lib/index.js`）用你本机已装的桌面版 VS Code 自带的 `code serve-web`，
   在一个随机回环端口上拉起真正的 VS Code Web 服务（`--without-connection-token`，
   默认文件夹 = DSH 工作区）。
2. 再通过 DSH 自己的 web server 把该服务**同源反代**到 `/dsh-vscode-ide/vscode/`。
   这一步是必需的而非美化：`code serve-web` 会回 `X-Frame-Options: SAMEORIGIN` 和
   `Content-Security-Policy: frame-ancestors 'self'`，跨源 iframe（比如 3080 里嵌 3197）
   会被浏览器直接拒绝；同源之后它就是第一方内容。代理同时剥掉这两个头，方便将来挂反代/局域网。
3. **client 半端**（`lib/client.js`）在右侧边栏注册一个标签页「代码」，内容就是一个指向上述路由的
   `<iframe>`。优先用 DSH 原生右侧栏（`sidebarRightTabs` + `slots`），
   若装了 `dsh-better-sidebar` 则注册进它的 tab 体系。
4. WebSocket 路径是 `<base>/stable-<commit>`，commit 随 VS Code 自动更新而变，
   所以每次（重）启动后都从 index.html 里现取，再注册 upgrade 路由。

## 依赖

- 本机装有**桌面版 VS Code**（自带 `code serve-web`，会按需下载对应的 vscode-server-web 构建）。
- DSH 的 web profile（`dsh web`）。

## 安装

### 从 npm 安装（推荐）

```bash
# 装进当前 web profile：装包 + 自动追加到 profile 的 bundle 列表
dsh plugin --profile web add dsh-vscode-ide

# 重启 dsh web，然后在右侧栏「+」菜单里选「代码」
```

`dsh plugin add` 会读包里的 `dsh.bundle`，把 `dsh-vscode-ide` 自动写进
`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`，不需要手改任何文件。

### 从 GitHub 安装

```bash
dsh plugin --profile web add git+https://github.com/BrotherCao/dsh-vscode-ide.git
```

### 从本地目录安装（开发用）

```bash
# 1) 把包放进 profile 的 local 目录
cp -r dsh-vscode-ide ~/.dsh/profiles/web/local/dsh-vscode-ide

# 2) profile 的 package.json：加依赖 + 加进 bundle 列表
#    ~/.dsh/profiles/web/package.json
#      "dependencies": { "dsh-vscode-ide": "file:./local/dsh-vscode-ide" }
#      "dsh": { "profile": { "bundles": [ ..., "dsh-vscode-ide" ] } }

# 3) 装一下依赖（file: 依赖会建立链接）
dsh plugin --profile web install

# 4) 重启 dsh web，然后在右侧栏「+」菜单里选「代码」
```

## 在插件市场里搜到它

DSH 的「插件 → 发现」是一个**索引源**列表，把下面任一地址加进去（`插件 → 发现 → 添加索引`），
就能在搜索框里搜到 `dsh-vscode-ide` 并一键安装：

```
https://cdn.jsdelivr.net/npm/dsh-vscode-ide/market/index.json
```

备用地址（GitHub 直连）：

```
https://raw.githubusercontent.com/BrotherCao/dsh-vscode-ide/main/market/index.json
```

索引文件就是仓库里的 [`market/index.json`](./market/index.json)，格式为 DSH 的
plugin market index format 1（`@deepseek-ai/dsh-plugin-market-index` 校验通过）。


## 配置

宿主端插件配置（profile 的 `cordis.patch.yml` 里该插件条目下的 `config`）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `folder` | DSH 工作区 | 作为 `--default-folder` 打开的目录 |
| `codeCli` | 自动探测 | `code`/`code.cmd` 的绝对路径（也可用 `DSH_VSCODE_CLI`） |
| `autoStart` | `true` | DSH 启动时就预热 VS Code 服务；设 `false` 则首次打开标签页时才启动 |
| `serverDataDir` | `~/.dsh/vscode-web/data` | VS Code Web 的 user-data / 扩展缓存目录 |
| `windowless` | `false` | 传 `--windowless`（无窗口模式） |

## 路由

| 路径 | 用途 |
| --- | --- |
| `/dsh-vscode-ide/vscode/` | VS Code Web UI（iframe 指向这里） |
| `/dsh-vscode-ide/status` | JSON 状态：`status`/`port`/`commit`/`folder`/`error`/`uptimeMs`/`log` |

服务还在启动或失败时，`/vscode/` 会渲染一张等待页（带最后几行日志和失败原因），不会白屏。

## 排障

- **首次打开很慢**：`code serve-web` 要下载对应版本的 vscode-server-web（约 200 MB，
  视网络 1–20 分钟）。期间页面上是等待页；`/dsh-vscode-ide/status` 的 `log` 能看到进度。
- **下载卡住 / TLS 报错**：Windows 上常见根因是 schannel 的证书吊销检查离线
  （`CRYPT_E_REVOCATION_OFFLINE`），表现为 CDN 请求直接失败。插件给子进程清空了
  `HTTP(S)_PROXY` 等变量并设 `NO_PROXY=*`（避免走本机代理的 CONNECT），但**不会**改系统证书策略；
  若仍失败，可先在终端用带 `--ssl-no-revoke` 的 curl 预拉一次，或把 VS Code 升级到能正常下载的版本。
- **端口**：VS Code 服务只监听 127.0.0.1 的随机端口，外部访问一律走 DSH 的同源路由。
- **一个 DSH 进程一个 VS Code 服务**：所有会话/标签页复用同一个，插件 dispose 时整棵进程树会被杀掉。

## 已知边界

- 依赖桌面版 VS Code 的 `serve-web` 子命令（VS Code ≥ 1.82 提供）。
- 侧边栏宽度由 DSH 的右侧栏决定；VS Code 内部的布局/字号在它自己的设置里改（会持久化到 `serverDataDir`）。
- 不用 `dsh-better-sidebar` 时走原生右侧栏；两者都在时装进 better-sidebar 的 tab 体系。

MIT
