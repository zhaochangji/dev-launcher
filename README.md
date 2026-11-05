# dev-launcher · 本地项目启动器（团队通用）

**给每个人用**：把这份文件夹拷给任何同事，双击「启动项目面板.app」，选自己的项目文件夹，就能一键启动本地开发环境。项目列表、移除记录等**每个人自己的数据存在 `~/.dev-launcher/`**，与这份代码完全分离——互不干扰，不携带任何人的个人路径。

**环境要求**：macOS + Node ≥ 16（无其他依赖，不装任何包管理器内容）。

## 新用户上手（30 秒）

```text
1. 双击「启动项目面板.app」→ 自动打开面板（默认 127.0.0.1:7877）
2. 首屏引导：点「📁 选择文件夹添加项目」→ 进入你的代码目录 → 「🔍 扫描此文件夹」
3. 勾选要用的项目 → 「添加选中」→ 点 ▶ 启动
```

浏览器没弹出也没关系：再双击一次即可（已在运行时直接打开页面）。

## 能做什么

| 能力 | 说明 |
|---|---|
| 📁 从文件夹添加项目 | 逐级浏览目录（📦 标记项目）→ 扫描（3 层深：monorepo apps/packages、子目录 server/web、uni-app、Go）→ 勾选添加；已收录的折叠展示 |
| ⬇ 从 git 克隆添加项目 | 添加弹窗切「从 git 克隆」：填 `git@…`（走本机 SSH key）或 `https://…` 地址 → 选目标父目录 → 克隆（后台执行、进度可看日志）→ 完成自动扫描 → 勾选添加 |
| 🏷 中文说明自动提取 | package.json description / README 首个中文标题段落 → 卡片说明；取不到显示占位 |
| 🚀 一键启动/停止 | 缺依赖自动 install（依赖根按「向上最近 lockfile」推断）；启动命令、包管理器（yarn/pnpm/npm）自动识别 |
| 📜 实时日志 | 每项目 `/tmp/dev-launcher/logs/<id>.log`，面板滚动查看 |
| 🔍 状态四态灯 | 运行中(含 PID) / 端口被外部进程占用 / 已停止 / 装依赖中；端口未知自动从日志嗅探 |
| 🗑 卡片移除/恢复 | 所有卡片 ✕ 移除（运行中先停）；带 `builtin` 标记的进恢复名单，页面底部 ↩ 恢复 |
| 🛡 w2 代理场景（可选） | 团队共享的场景包：一键 `w2 add --force` 切换（同名规则集覆盖互斥）、w2 服务启停；无场景配置时自动隐藏 |
| 🚇 多进程组合 | 一个卡片按序拉起多个进程（如 vite + led 隧道） |

## 每个文件放哪（重要）

```text
dev-launcher/（这份代码，可拷贝/放 git 共享）
├── 启动项目面板.app       # 双击入口（.command 是它调用的实现脚本）
├── 启动项目面板.command   # Terminal 兜底入口（不受隔离限制）
├── 打包发给同事.command   # 打 zip（仅含运行所需文件）
├── 分发说明.md            # 给接收方的打开说明
├── server.js              # 面板服务（纯 Node 标准库，零依赖，仅监听 127.0.0.1）
├── projects.json          # 「团队共享」内容：w2 代理场景包（whistleGroup + scenarios）
└── public/index.html      # 单文件 UI

~/.dev-launcher/（每人自己的，代码里读不到别人的）
├── projects.local.json    # 你的项目列表（面板自动维护，也可手改：加字段见下）
├── removed.json           # builtin 项目移除名单
├── scenarios/ state.json port
/tmp/dev-launcher/         # 运行日志（logs/、panel-server.log），机器本地
```

> 卸载 = 删掉 dev-launcher 文件夹 + `rm -rf ~/.dev-launcher /tmp/dev-launcher`。

## projects.local.json 手写条目（可选，扫描之外的特殊需求）

```json
{
  "id": "my-combo",
  "group": "我的组合",
  "name": "子应用+主应用",
  "desc": "说明",
  "dir": "/Users/你的用户名/仓库/子应用目录",
  "install": { "cwd": "/仓库根", "cmd": "pnpm", "args": ["install"], "marker": "/仓库根/node_modules" },
  "start": [
    { "cmd": "yarn", "args": ["run", "dev"], "cwd": "/另一个仓库根", "env": { "NODE_OPTIONS": "--openssl-legacy-provider" } },
    { "cmd": "pnpm", "args": ["dev"], "delayMs": 3000, "pkill": "apps/xxx" }
  ],
  "port": 5173, "url": null, "scenario": null, "builtin": false,
  "note": "卡片备注"
}
```

字段：`start[]` 支持多进程（cwd/env/delayMs/pkill 每步独立）；`port` 未知填 null（日志嗅探）；`scenario` 关联 w2 场景 id（启动自动应用）；`builtin:true` 的卡片移除后可恢复。

## 团队共享：场景包

`projects.json` 的 `scenarios` 是唯一共享配置（w2 whistle 规则）。给团队加场景：编辑该数组，各成员拉最新代码即可。**`whistleGroup` 保持与团队现有规则集名称一致**（同名规则集 `--force` 覆盖实现场景互斥）。

项目**不**通过 projects.json 共享（每人路径不同）；同事想快速获得一组推荐项目，把带 `builtin:true` 的条目发给他，粘进自己的 `projects.local.json` 即可（路径需各自改）。

## 一次性浏览器侧配置（w2 方案的项目才需要）

面板底部「一次性配置引导」：Zero Omega 插件（代理 127.0.0.1:8899）→ w2 根证书信任 → led login → passport 白名单。非内网用户面板不会显示该区块。

## 分发给同事（重要）

macOS 会给**下载/zip 解压/微信传输**的文件打「隔离」标记，未签名的程序会被 Gatekeeper 拒绝（弹窗只有「完成/移到废纸篓」）。**不是程序有问题**，本机没有 Apple 开发者签名（`0 valid identities`），无法做真正的双击免拦截。

三种分发方式，按推荐排序：

| 方式 | 同事操作 | 门槛 |
|---|---|---|
| **① 团队 git 仓库**（推荐） | `git clone` 后**直接双击 .app** —— git 下载不打隔离标记，零摩擦 | 需仓库权限 |
| **② zip / 微信** | 解压 → 终端执行一次 `xattr -dr com.apple.quarantine <dev-launcher 目录>` → 双击 .app | 一次性终端命令 |
| ③ 购买 Apple Developer ID | 签名+公证后任何传输都可直接双击 | 99 美元/年 |

- 打包：双击（或运行）**`打包发给同事.command`** → 生成 `dist/dev-launcher.zip`（只含运行所需文件）
- 接收方说明：**`分发说明.md`**（含三种打开方式和常见问题，随包附带）
- 兜底：任何情况下 `bash 启动项目面板.command` 都能在终端直接运行（shell 不经过 Gatekeeper）

## 常见问题

| 问题 | 处理 |
|---|---|
| 双击 .app 仍被拦（如经 zip/网络传输后被隔离） | 右键 → 打开；或系统设置 → 隐私与安全性 → 仍要打开；或终端执行 `bash 启动项目面板.command` |
| 面板起不来 | 看 `/tmp/dev-launcher/panel-server.log`；确认装了 Node（`node -v`） |
| 7877 被占 | 自动改用 7878-7890（面板地址以 .command 输出为准） |
| 老项目 webpack 报 `ERR_OSSL_EVP_UNSUPPORTED` | 需要 node ≤16 或 `NODE_OPTIONS=--openssl-legacy-provider`（扫描添加的项目已自动带上；手写条目自己加 env） |
| 页面打开不是本地代码 / 登录态问题 | w2 场景没切、Zero Omega 没启用——见面板场景区与底部引导 |
| 想让某项目常驻不同端口 | 改 `projects.local.json` 对应条目的 `port`（手写）或看日志嗅探值 |
| 「🚫 启动后可访问」 | 项目未运行（含 staging 域名类）——点「▶ 启动」，识别到地址后按钮自动变为可点 |
| 「⏳ 地址识别中」 | 正在编译/启动，日志出现端口后自动变链接（每 3 秒自动刷新，老项目编译 1-3 分钟正常） |
| 「🔗 访问 ⚠」（琥珀色） | 端口有监听但请求无响应：可能仍在编译/路由未就绪，或该端口被其他项目占用——点日志看进度，链接仍可手动打开验证 |

## 安全

面板仅监听 127.0.0.1、只接受本机请求；启动的项目进程独立存活（关面板不影响）；停止 = 杀进程组 + pkill 匹配 + 端口清理兜底。
