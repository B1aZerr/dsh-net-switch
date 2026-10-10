# dsh-net-switch

给 DeepSeek Harness 一个**运行时**出网开关：一键在「走本地 Clash Verge 代理」和「直连（含局域网）」之间切换，**不用重启 Harness**。

> **English:** a runtime network switch for DeepSeek Harness. One click flips Harness's own egress — LLM calls, web search/fetch and HTTP MCP traffic, plus the proxy environment of agent shell subprocesses — between a local Clash Verge proxy and direct/LAN, without restarting. Loopback and every private range always stay direct. Driven from a status chip in the session header (immediately right of the mode selector), the `network_mode` agent tool, and the `/net` slash command.

三个入口驱动同一个开关：

| 入口 | 用法 |
|---|---|
| **GUI 头部小开关** | 会话头部、**紧邻模式选择按钮右侧**的状态胶囊：绿点 `代理` / 灰点 `直连` / 琥珀 `代理离线`，点一下即切换。它注册在 `conversation.session.header.actions`（`order: -5`，正好夹在 `agent-preset` 的 −10 与 `job-list` 的 20 之间），因此是**原生流式排布、随窗口自适应**，不覆盖任何已有控件 |
| **Agent 工具** | `network_mode`：模型可以自己判断「这个任务需要翻墙」而临时切到 clash，用完切回 lan |
| **斜杠命令** | `/net clash`、`/net lan`、`/net status` |

---

## 1. 为什么需要这个插件

Harness 自己的代理支持是**启动时一次性解析**的：`@deepseek-ai/dsh-http-proxy` 在第一个插件加载之前，从启动环境变量（再回退到 `$DSH_HOME/.env`）读一次策略，然后装成进程级 undici dispatcher。它还明确不支持 SOCKS / PAC / **操作系统代理探测**——所以 Clash Verge 的「系统代理」开关对 Harness **完全无效**，只有 `shell` 里跑的子进程（`curl`、`git`、`npm`）会受系统代理影响。

结论就是：想换路由，官方路径只有「改环境变量 + 重启 Harness」。

本插件的做法是把那个进程级 dispatcher 换成一个**每次请求现判**的 dispatcher，于是切换是瞬时的、可逆的：

```
                      ┌──────────────────────────────┐
  LLM 调用 ─┐          │  SwitchDispatcher            │
  web 搜索 ─┼─ fetch ─▶│  mode=clash → ProxyAgent     │─▶ 127.0.0.1:7897 (Clash Verge)
  web 抓取 ─┤          │  mode=lan   → 原直连 dispatcher│─▶ 直连
  HTTP MCP ─┘          │  命中 NO_PROXY → 永远直连     │
                      └──────────────────────────────┘
  shell 子进程 (git/curl/npm/pwsh) ← HTTP_PROXY / HTTPS_PROXY / NO_PROXY / NODE_USE_ENV_PROXY
```

要点：

- **回环与私网段永远直连**：`localhost`、`127.0.0.0/8`、`::1`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16`。这一条比官方策略更严——官方只自动绕过回环，私网会被一起送进代理。NAS、局域网 IP、本地服务不会被代理吞掉。
- **失败开放（fail-open）**：选了 clash 但端口探不通时，流量自动走直连，**不会把 agent 卡死**；同时状态里保留 `mode: clash` + `degraded: true`，胶囊显示琥珀「代理离线」、工具返回值里也写清楚。想改成「没代理就报错」的严格模式，把 `autoFallback` 设成 `false`。
- **不碰 Clash Verge 自己的设置**：只读它的 `verge.yaml` 用于自动发现混合端口，不去开/关它的系统代理或 TUN，也不动你的订阅和节点。
- **卸载即还原**：插件卸载时精确恢复原来的 dispatcher、原来大小写两份的代理环境变量，并关闭自己创建的代理连接。

## 2. 安装

前置：一个带 profile 的 DSH（本机是 `desktop`），Clash Verge Rev 在跑（混合端口默认 7897，插件会自己从 `verge.yaml` 读）。

```powershell
# 方式 A：直接从 GitHub 装（推荐）
dsh plugin --profile desktop add github:B1aZerr/dsh-net-switch

# 方式 B：克隆到本地后就地链接（改代码即时生效，开发时用）
git clone https://github.com/B1aZerr/dsh-net-switch
dsh plugin --profile desktop add link:<克隆路径>\dsh-net-switch

# 方式 C：从打包好的 tgz 装
dsh plugin --profile desktop add file:<解压路径>\dsh-net-switch-0.1.0.tgz
```

预构建 tarball 也挂在 Release 上（无需构建，跳过 `allowBuilds` 构建授权）：

```
https://github.com/B1aZerr/dsh-net-switch/releases/latest/download/dsh-net-switch.tgz
```

命令会在 profile 的 `package.json` 里同时登记 `dependencies` 和 `dsh.profile.bundles`。装完：

```powershell
node dsh-net-switch\tools\verify-install.mjs      # 对运行中的 host 自检，见第 5 节
```

然后**会话头部、模式选择按钮的右侧**应该出现状态胶囊（默认 `直连`），点它或打 `/net clash` 即可切换。

### 三个安装陷阱（都是本机实测踩到的）

1. **host 半是模块级缓存，client 半不是。**
   DSH 按入口文件的 URL 缓存已导入的 host 模块，所以**改了 host 代码后，光重装/改文件不会生效**，必须让条目重新导入：在「设置 → 插件」里把 `net-switch` 关掉再打开，或重启 DSH Desktop。client 半由 host 按文件字节现场组包，**刷新页面即可**（`link:` 安装下 DSH 的 HMR 也会自己推一次）。
2. **undici 必须解析得到。**
   插件的加载器依次尝试：`require` 缓存里已被 DSH 加载的那份 → 裸 `undici` → `$DSH_HOME/profiles/*/node_modules/undici` → 应用自带 `app.asar/dsh/node_modules/undici`。
   注意 **host 进程通常没有 `DSH_HOME` / `DSH_PROFILE`**（那两个变量是注入给 agent 子进程的，不是给应用本身的），所以只按环境变量找会失败——这一点实测确认过，加载器因此改为扫描 `~/.dsh/profiles/*`。
   实测（两处，都通过）：① 在一个**没有本地 `node_modules`、也没有 `DSH_HOME`/`DSH_PROFILE`** 的普通 Node 进程里，加载器解析成功；② 在**运行中的 host 进程**里，把插件目录下的 `node_modules` 整个移除后重载条目，`inProcessRouting` 仍然是 `true`。
   也就是说正常安装**不需要任何额外步骤**。`node tools/link-undici.mjs` 只是给其他环境兜底：它会就地链接 DSH 自带的那份（需要能创建目录联接的权限），或直接 `npm i undici@^7`。
   > 该脚本清理旧链接时用的是 `rmdir`（只摘链接）：Windows 把目录联接报告成普通目录，**递归删除会顺着联接清空 DSH 自己那份 undici**。本机实测已确认链接摘除后 DSH 的 `node_modules/undici`（210 个文件）完好。
3. **不要用浮层（`shell.overlay`）挂这个开关。**
   最初的版本把胶囊固定在右上角，连着踩了两个坑。`shell.overlay` 的实际契约是
   ```css
   .BynINW_overlayLayer { position: absolute; inset: 0; z-index: 20; pointer-events: none }
   ```
   而桌面壳自己的窗口标题栏带（最小化 / 最大化 / 关闭）占据顶部约 40px 并压在它上面：`top:10px` 时胶囊**在屏幕上完全看不见**（可槽位占用者仍是 `active`、Inspect 也查得到，所以这个坑只能靠看像素发现）；挪到标题栏带下方（`top:48px`）之后又**压住了头部那一排按钮**。
   最终改为注册进头部自己的动作列表 `conversation.session.header.actions`（`order: -5`，正好夹在模式选择器 `agent-preset` 的 −10 与 `job-list` 的 20 之间）：原生流式排布、随窗口自适应、不覆盖任何控件，也不需要任何定位或点击穿透处理。
   > 排查经验：**Inspect 报「占用者 active」不等于「看得见」**。这次是靠 `windows_computer_use` 截图 + 裁剪放大才确认的；顺带一提，同一次 OCR 里能看到 `/net` 命令的说明文字，说明 host 半的注册面本来就在正常显示。

## 3. 配置

在 profile 的 `cordis.patch.yml` 里覆盖（可选，全部有默认值）：

```yaml
- id: net-switch
  name: 'dsh-net-switch'
  config:
    proxy: 'http://127.0.0.1:7897'   # 显式代理；省略则依次看环境变量 → verge.yaml → 默认 7897
    mode: lan                        # 启动模式：clash | lan（默认 lan，即保持现状）
    autoFallback: true               # 代理不通时自动回退直连（false = 严格模式，请求直接失败）
    probeIntervalMs: 5000            # 探活间隔
    probeTimeoutMs: 2000             # 单次探活超时
    noProxy: ['nas.home.arpa']       # 额外绕过项（主机名/IP/CIDR）
    persist: true                    # 记住最后一次选择，重启后恢复
    statePath: null                  # 状态文件路径；默认 $DSH_HOME/storages/dsh-net-switch.json
    publishEnvToChildren: true       # 同时把代理写进子进程环境（git/curl/npm/pwsh）
    enabled: true                    # false = 整个插件不启用
```

模式来源优先级：`config.mode` → 状态文件里记住的选择 → `lan`。

### HTTP 路由

宿主暴露两个仅限回环的路由，GUI 胶囊靠它们工作：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/dsh-net-switch/state` | 返回完整状态 JSON（含 `mode` / `effective` / `reachable` / `degraded` / `proxy` / `noProxy` / `summary`） |
| `POST` | `/dsh-net-switch/mode` | 请求体 `{"mode":"clash"\|"lan"}` 或 `{"toggle":true}`，返回新状态 |

安全栅栏：`Host` 必须是回环地址；`POST` 还要求 `Origin`（若浏览器给了）与 `Host` 同源。别的网页无法通过跨站请求改你的出网路由。

## 4. 工作原理与代码结构

| 文件 | 职责 |
|---|---|
| [lib/plugin.js](lib/plugin.js) | **host 入口**：两个路由 + `network_mode` 工具 + `/net` 命令的接线 |
| [lib/index.js](lib/index.js) | 3 行转发壳，指向 `plugin.js`（见第 2 节陷阱 1：换入口文件名是让 host 半就地重载的手段） |
| [lib/policy.js](lib/policy.js) | 纯策略：模式词表、代理 URL 校验（拒绝 SOCKS/PAC）、带 IPv4 CIDR 与 IPv6 字面量的 NO_PROXY 匹配器 |
| [lib/dispatcher.js](lib/dispatcher.js) | `SwitchDispatcher`：继承 undici `Dispatcher`，只覆写 `dispatch`，按当前模式把请求交给代理或直连 |
| [lib/env.js](lib/env.js) | 子进程代理环境：大小写两份一起写/一起清，并设置 `NODE_USE_ENV_PROXY=1` |
| [lib/controller.js](lib/controller.js) | 开关本体：状态、探活、持久化、失败开放、卸载还原 |
| [lib/undici-loader.js](lib/undici-loader.js) | 四级 undici 解析（见第 2 节陷阱 2） |
| [lib/detect.js](lib/detect.js) | 从 `verge.yaml` 读 `verge_mixed_port` / `enable_system_proxy` / `enable_tun_mode`（只读） |
| [lib/state.js](lib/state.js) | 记住最后一次选择，原子写入，坏文件当作「没有偏好」 |
| [client/client.js](client/client.js) | 浏览器半：手写 CJS bundle，注册到 `conversation.session.header.actions`（order −5，模式选择按钮右侧）的头部胶囊 |

几个刻意的取舍：

- **为什么必须有 undici**：实测过 `NODE_USE_ENV_PROXY` 只在**进程启动时**被 Node 读取——启动后改 `process.env` 对 `fetch` 完全无效（见 [probes/](probes/)）。所以运行时切换只能换全局 dispatcher。
- **为什么不用 tsdown 构建客户端**：客户端半只有 `react` 一个外部模块，手写 `window.__ModuleLoader__.load` 包装即可，零构建链、零 devDependency，改完即可测。
- **为什么状态存 `$DSH_HOME/storages/`**：`link:` 安装的插件目录可能只读或多人共享，状态属于用户环境而不是代码。
- **开关挂在头部原生槽位，而不是浮层**：`conversation.session.header.actions` 是头部自己的动作列表，插进去就自动获得与模式选择器一致的排布、间距和窗口自适应；浮层带来的遮挡与点击穿透问题见第 2 节陷阱 3。
- **探活用裸 TCP connect**，不是发一个走代理的请求：这样才能真的测「代理本身在不在」，而不会被直连路径答上来（这个写法来自 dsh-clash-proxy）。

## 5. 验证

### 本机实测记录（装完当场跑的）

| 检查 | 结果 |
|---|---|
| `GET /dsh-net-switch/state` | 200；`mode=lan`、`proxySource=clash-verge:verge.yaml`（自动识别出混合端口 7897） |
| `inProcessRouting` | `true` —— undici 7.30.0 已接管进程内 fetch |
| 跨源 `POST /dsh-net-switch/mode`（`Origin: https://evil.example`） | **403** 拒绝 |
| `conversation.session.header.actions` 的占用者 | `registrant=dsh-net-switch, id=dsh-net-switch, order=-5, active=true`（夹在 `agent-preset` −10 与 `job-list` 20 之间 = 模式选择按钮右侧） |
| **真点头部胶囊**（GUI → host 往返） | 点一下：`mode=lan → clash`、`lastChangeSource=gui`、胶囊变绿点 `代理`、子进程立刻拿到代理环境；再点一下：回到 `lan`、环境清空、状态文件落盘。两次点击 `switches=2` |
| `network_mode(mode=clash)` 后的子进程环境 | `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` = `http://127.0.0.1:7897`，`NO_PROXY` 9 条，`NODE_USE_ENV_PROXY=1` |
| 同一 shell 里 `node fetch https://www.google.com/generate_204` | **204**（切换前是超时失败） |
| 切回 `lan` 之后 | 5 个环境变量全部清空、google 重新失败、状态文件落盘 `mode=lan` |
| loopback | 始终直连（state 路由 200），未被代理吞掉 |

### 自检工具

```powershell
node tools\verify-install.mjs        # 对运行中的 host 自检（默认 http://127.0.0.1:19387）
```

会核对：host 半是否加载、**进程内路由是否真的接管**、代理是否可达、私网绕过是否齐全、跨源 POST 是否被拒，以及浏览器半的组合输入（`dsh.client` 声明、`exports["./client"]`、bundle 的 loader 包装与 id、`conversation.session.header.actions` 注册）。

> 浏览器 bundle 不能靠未认证 HTTP 核验：DSH 用 **combo + 版本号**提供客户端包，而 web 面在**每进程启动令牌**后面（只经 IPC 给桌面壳）。实测把 URL 猜成 `/plugins/<id>/client.js?rev=…` 时，**连已知能正常渲染的插件（task board、market、billing）也一样 404**，所以那种 404 不构成证据。工具因此只校验组合输入，实际是否渲染请用 Inspect 桥（问 `conversation.session.header.actions` 的占用者）或直接看会话头部。

### 测试

零依赖测试（`node:test`），19 个用例：

```powershell
cd <克隆路径>\dsh-net-switch
npm test
# 或者绕开 npm，显式列出测试文件（Windows 的 cmd 不会展开通配符，所以要写全）：
node --test --test-isolation=none test/policy.test.mjs test/routing.test.mjs test/client.test.mjs test/plugin.test.mjs
```

> `--test-isolation=none` 是必需的：Node 默认让每个测试文件各起一个子进程并用管道收集输出，而 DSH 的沙箱禁止带管道的子进程（EPERM）。同进程运行同时也让「全局 dispatcher 被接管」这件事可以被真的断言。

| 测试文件 | 覆盖 |
|---|---|
| [test/policy.test.mjs](test/policy.test.mjs) | CIDR/主机名/通配 匹配边界（`172.15` vs `172.16`、`notexample.com` 不算子域）、SOCKS/PAC 拒绝、环境变量精确还原、状态文件往返与损坏容错 |
| [test/routing.test.mjs](test/routing.test.mjs) | **端到端**：真起一个会答 CONNECT 的假代理，用进程级 `fetch` 断言「公网 → 走代理（CONNECT 隧道）」「回环/私网 → 绕过直连」、切换后环境还原且不再触达代理、卸载后原 dispatcher 回归；代理不可达时失败开放 + `degraded` 上报；`autoFallback:false` 不被覆盖 |
| [test/client.test.mjs](test/client.test.mjs) | 载入真实 bundle，用最小 React hook 运行时渲染胶囊：注册进 `conversation.session.header.actions`、order 必须落在 `agent-preset`(−10) 与 `job-list`(20) 之间、**不做任何定位**、hover 只改配色不移动、`直连`/`代理`/`代理离线` 三种呈现、点击后 POST 的 body 是 `{"mode":"clash"}` |
| [test/plugin.test.mjs](test/plugin.test.mjs) | 用假 Cordis 上下文跑真 `apply()`：dispatcher 真正接管 `fetch`、两个路由与工具/命令按契约注册、403/405/400 栅栏、工具与命令行为、卸载还原 |

### 一次性实验（把设计假设钉死，可重跑）

| 脚本 | 结论 |
|---|---|
| [probes/env-dynamic-probe.mjs](probes/env-dynamic-probe.mjs) | 进程启动后改 `NODE_USE_ENV_PROXY`/`HTTPS_PROXY` 对 `fetch` **无效** → 所以不能只靠环境变量 |
| [probes/undici-interop-probe.mjs](probes/undici-interop-probe.mjs) | npm 的 undici `setGlobalDispatcher` **能**管住 Node 内建 `fetch`，自定义 `Dispatcher` 子类同样有效 → 方案成立 |
| [probes/bundle-url-probe.mjs](probes/bundle-url-probe.mjs) | 客户端 bundle 的 URL 形状与「直接猜 URL 一定 404」的对照实验 |

## 6. 已知限制

- **只支持 HTTP CONNECT 代理**（Clash 的混合端口就是），SOCKS/PAC 会被明确拒绝并保持直连，不会静默借用别的协议。
- **子进程的 NO_PROXY 匹配弱于进程内**：进程内是自己实现的 CIDR 匹配；发布给子进程的列表里，`curl` 懂 CIDR，而 Node 自带匹配器只认主机名条目（和官方 `dsh-http-proxy` 一样）。因此子 Node 程序对私网段的绕过不如进程内精确。
- **`git clone git@…`（SSH/22）不走代理**，只覆盖 HTTP(S)。
- **`NODE_USE_ENV_PROXY=1` 会一并生效于子进程**（含模型自己写的 Node 脚本）。当前代理 URL 是 `127.0.0.1:7897` 不含账号密码；若你把 `proxy` 配成带 `user:password` 的地址，且不希望它进入子进程，请设 `publishEnvToChildren: false`。
- **`web_fetch` 是代理豁免的**：`dsh-web-fetch-http` 会把请求钉在自己校验过的地址上（它需要进程级 dispatcher 承载不了的单次请求状态），所以那一条通道不随本开关变化。LLM 调用、`web_search`、HTTP MCP 都走全局 dispatcher，会随开关变化。
- **遥测（OTLP）与部分 SDK 自带传输不受影响**：官方也说明走 `node:http` 的导出器碰不到全局 dispatcher。
- **探活是 TCP 层**的：端口开着的代理就算节点全挂也算「可达」。节点健康属于 Clash 的职责，不是 Harness 的。
- **host 代码改动在 `link:` 安装下需要重载条目**（关掉再打开，或重启）——见第 2 节。这是 DSH 的模块缓存行为，不是本插件的缺陷。
- **Clash Verge 的 TUN 模式**开着时，直连路径本身可能已被内核层接管；本插件只切 Harness 自己的出网，不去改系统网络。

## 7. 卸载

```powershell
dsh plugin --profile desktop remove dsh-net-switch
```

卸载时自动恢复原 dispatcher 与环境变量。想彻底清干净，再删掉状态文件 `$DSH_HOME/storages/dsh-net-switch.json`（或在配置里把 `persist` 设为 `false`）。

## 8. 收录到社区插件列表

本插件可以提交到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)——DSH 社区的插件精选列表（也是 `dsh-plugin` topic 生态的入口站）。

它的准入方式是**一个 PR 只加一个文件**：`data/plugins/<owner>__<repo>.yml`；两个 README 由脚本从 `data/plugins/*.yml` 生成，**不要手改**。仓库里已经备好了可以直接提交的条目：[.community/awesome-dsh-plugin.yml](.community/awesome-dsh-plugin.yml)，复制成 `data/plugins/B1aZerr__dsh-net-switch.yml` 即可。

CI 的检查顺序：

1. 一个 PR 最多 3 条；
2. 目标仓库的 `package.json` 必须声明 **`dsh.bundle`**（本插件有；只声明 `dsh.client` 会被拒）；
3. **仓库创建满 1 天**（用来过滤「提交前几分钟才建好」的仓库）；
4. `awesome-lint` 与站点构建（双语一致性、日期、截图等）。

另外要在仓库设置里加上 **`dsh-plugin`** topic（列表和多个插件市场都按这个 topic 抓取）。本仓库已加上该 topic，并已发布 `v0.1.0` Release（附预构建 tarball）。

## License

MIT
