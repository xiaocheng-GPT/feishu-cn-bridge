# feishu-cn-bridge

[![license](https://badgen.net/badge/license/MIT/blue)](LICENSE)

> 把飞书 / Lark 桥接到你本机的 [DeepSeek (dsh)](https://github.com/deepseek-ai/dsh) / [Codex](https://github.com/openai/codex) / [Claude Code](https://www.anthropic.com/claude-code)，在群里 @ 机器人就能让它在指定项目目录里干活，结果以流式 Markdown 卡片实时回到群里。
>
> **项目 = 群 = 固定工作目录（cwd）**，**话题（thread）= 一个会话（session）**。

一句话：你在飞书群里发「帮我加个登录接口」，机器人就在这个群绑定的代码目录里跑 agent，边跑边把推理、命令、改动、结果更新到一张卡片上；点 ⏹ 可随时终止。

## 🇨🇳 面向国内开发者的适配版

本项目在 **feishu-agent-bridge** 基础上做了**国内开发环境适配**，并持续迭代国内版：

- **内置 DeepSeek (dsh) 后端**，通过官方 **ACP 协议**（Agent Client Protocol）接入，本机直连、零海外网络依赖，是国内开发者的首选后端，默认即路由到 dsh。
- **默认后端智能选择**：优先 dsh → 其次 Codex，装好即用，无需额外配置。
- 适配飞书国内版生态：中文消息默认全程无感，语音转文字、文档评论回复等能力一应俱全。
- 面向国内开发环境的持续迭代：优先保证 DeepSeek / 通义等国产 agent 的接入体验与新特性跟进。

```
飞书群消息 ──长连接──▶ bridge ──▶ dsh (ACP) / Codex app-server / Claude Agent SDK（每会话一独立后端）
   ▲                      │
   └─── 流式 Markdown 卡片 ◀┘
```

---

## ⚡ 安装

两步打开本机网页控制台。装好 Bridge、打开控制台，再在页面里启动后台服务、添加第一个 Bridge 机器人。

```bash
# 1. 全局安装 Bridge
npm i -g @modelzen/feishu-cn-bridge

# 2. 打开本机网页控制台
# 启动服务、添加好机器人后，这条前台命令即可 Ctrl+C 关闭
feishu-CN-bridge web
```

> 💡 内置 dsh（DeepSeek）后端需要本机有 dsh CLI：`npm i -g @deepseek-ai/dsh`。没有也能用，Web 控制台会提示你安装。

不想自己敲？把下面这段发给 **Codex / dsh / Claude** 等 AI agent，让它替你装好并跑起来：

```text
帮我在这台电脑上安装并跑起来 feishu-cn-bridge：

1) 先 node -v 确认有 Node.js(≥20)，没有就先装好；
2) 再确认 agent CLI：dsh (npm i -g @deepseek-ai/dsh)、codex CLI 至少装一个；
3) 全局安装：
   npm i -g @modelzen/feishu-cn-bridge
4) 前台运行，打开本机 Web 控制台：
   feishu-CN-bridge web
   它一启动会打印一个 http://127.0.0.1:xxxx/?token=... 的链接。
5) 把那个链接发给我；
6) 然后用文字告诉我接下来怎么做：
   - 我在浏览器打开这个链接；
   - 点页面上的「启动」按钮，把后台服务跑起来；
   - 启动后页面会自动进入可写控制台，在里面扫码添加我的第一个飞书机器人；
   - 成功创建机器人后，前台那条 feishu-CN-bridge web 就可以 Ctrl+C 关掉，不影响后台服务。
```

---

## ✨ 特性

- **群 = 项目，话题 = 会话**：每个群绑定一个本地目录；群里 @ 机器人就在该目录跑 agent。对某条消息开话题 = 一条独立连续会话（自动 resume）。
- **三种后端**：
  - **DeepSeek (dsh)** —— 内置、默认优先，走 **ACP 协议**，本机直连，指导国内开发（Go 写的会话级编程 agent）。
  - **Codex**（能力最全：goal / steer / compact / resume + 真沙箱只读档）。
  - **Claude Code**（SDK 内置、复用本机登录、能力较精简）。
  - 建项目时按需选，同一台机可混用。
- **流式卡片**：思考摘要、进度和工具按时间顺序展示，连续工具分组折叠，展开后查看完整命令。卡片接近容量限制时先省略大段工具输出并保留操作；极端长度下显示明确的省略数量。运行中显示耗时，完成后收起过程、突出回答。⏹ 随时终止，卡死有 watchdog 自动回收。
- **运行中补充要求**：使用引导（steer）时，消息确认接收后创建新输出卡片，旧卡保留此前内容，后续输出在新卡继续；同一个 agent turn 持续执行。排队模式及不支持 steer 的后端仍在下一轮处理。[行为与验收说明](docs/testing/run-card-steer.md)。
- **免 @ + 自主目标**：话题 / 单会话群里可直接说话不必每次 @；`/goal <目标>` 让它自主多轮干到完成。
- **多模态**：消息里直接发图片（读图）、发文件附件（下载到本地交给 agent 打开分析）。
- **按需获取本地文件**：把正常回答里的本地文件引用原地替换为蓝色交互文字，保留文件名/路径、前后说明和顺序，不追加文末文件区或独立按钮。首次点击由 bridge 发送原文件附件到当前会话，不启动 agent、不导入在线文档；发送中防连点，成功后各处同文件入口都定位已发送消息，发送记录跨重启保存。支持 Markdown 链接、绝对路径、反引号路径/文件名（含空格）及 Codex 文件引用；每轮最多 10 处交互入口，单文件不超过 30 MB。获取时检查任务发起人/管理员身份、当前项目权限和文件变化。[识别规则与测试步骤](docs/testing/local-file-access.md)。
- **☕ 咖啡一下（反向桥）**：离开电脑时，把你本机正在跑的 Codex / dsh CLI 的「需要审批 / 提问 / 任务完成」接管到飞书私聊 —— 在手机上点确认 / 回答它就继续，机器保持不睡。
- **文档评论回复**：在飞书云文档（doc / docx / sheet / bitable 多维表格，含 wiki）的评论里 @ 机器人，它读评论、跑 agent、把答案回到同一条评论线程。
- **双控制台**：私聊机器人弹交互菜单（新建项目 / 设置 / 用量 / 诊断 / 重连）；网页控制台还能管后台服务、看实时日志、扫码加机器人。
- **多飞书机器人**：一台机器注册多个机器人、可同时连接，各自项目 / 会话独立。
- **三档权限沙箱**：每个项目可设「只读 / 读写 / 完全访问」，由 OS 沙箱强制（macOS / 原生 Windows）。
- **跨平台常驻**：macOS / Windows / Linux·WSL 均可注册成后台服务、开机或登录自启、崩溃自动拉起。

---

## 💬 使用

它有两个方向 —— 飞书群指挥本机 agent，和把本机 agent 接管到飞书。

### A. 飞书群 → 本机 agent（主用法）

- **建项目**：私聊机器人 → 控制台菜单「新建项目」→ 绑定一个本地目录 → **选后端（dsh / Codex / Claude）** → 机器人建好群、置顶命令说明、把你拉进去。
- **两种群按场景选**：
  - **👥 多话题群**：@ 机器人开话题，每个话题是一条**独立会话**（上下文隔离、可并行）。适合多人协作 / 一人并行多任务。
  - **💬 单会话群**：整群就是**一条连续会话**、全程**免 @**。适合个人单线深入、像私聊一样直接聊。
- **干活**：群里 @ 机器人（或话题内免 @）描述需求，流式卡片回结果；卡片上 ⏹ 随时终止当前轮。
- **自主目标**：`/goal <目标>` 让它多轮自主执行到完成；运行卡上有 **⏹ 终止**（立刻停）和 **🎯 结束目标**（本轮跑完停）。
- **斜杠命令**：`/model`、`/resume`、`/compact`、`/context` 等，按所选后端能力自适应裁剪（不支持的项不显示）。
- **发图 / 附件**：发图片读图、发文件（日志 / PDF / 代码）让 agent 打开分析。
- **用量**：私聊「用量」看 5h / 7d 限额（剩余 % + 重置时间）与个人统计，一键生成可转发的**战绩分享卡**（数据来自 Codex 个人资料页，需 ChatGPT 登录）。

### B. 本机 agent → 飞书（☕ 咖啡一下）

在本机用 Claude Code / Codex / dsh 干活、要离开电脑时开启「咖啡一下」：本机 agent 需要**审批 / 提问 / 报告完成**时，推到你的飞书私聊，你在手机上点一下就让它继续；机器保持不睡（屏幕可关、CPU 照跑），回到电脑自动交还终端。

---

## 🖥️ CLI 一览

日常基本只用 `start`（起后台）和 `web`（开控制台），其余动作网页里都有按钮。

```
feishu-CN-bridge run [--bot <名>]            前台启动（没配置先扫码 init；Ctrl+C 优雅退出）
feishu-CN-bridge start                       后台 daemon：装系统服务、开机/登录自启、崩溃自动拉起
feishu-CN-bridge status|logs|restart|stop    daemon 生命周期（logs -f 跟随日志）
feishu-CN-bridge update [--check]            更新到最新版（npm i -g）并自动重启 daemon
feishu-CN-bridge web [--port <端口>]          打开本机网页控制台（默认端口 51847）
feishu-CN-bridge bot init|list|use|rm        多机器人：扫码注册 / 列表 / 选要连接的 / 移除
feishu-CN-bridge doctor                      本地自检：后端 / 登录 / 当前机器人
```

> ⚠️ 后台服务必须**全局安装**（`npm i -g`），别用 npx —— 服务里硬编码了 CLI 路径，npx 临时缓存会被清理。前台 `run` 用 npx 没问题（单次进程）。

需要使用指定版本的 Codex 时，在 `start` 时设置 `CODEX_BIN`，服务会保存该路径并在重启后继续使用。已有服务需要重新生成配置；详见[指定后台 Codex、更新和取消覆盖](docs/configuration/codex-bin.md)。dsh 同理可用 `DSH_BIN` 指定路径。

---

## ⚙️ 配置与数据

所有本地状态都在 `~/.feishu-CN-bridge/`（机器人配置、项目 / 会话注册表、AES-256-GCM 加密的密钥库）。卸载时删掉这个目录即可清干净。

### 自定义空白项目目录（可选）

「新建项目」时把**文件夹路径留空**，默认会创建到 `~/.feishu-CN-bridge/projects/<项目名>`。如需改到其他磁盘，可编辑诊断卡所显示的当前机器人 `config.json`（通常是 `~/.feishu-CN-bridge/bots/<appId>/config.json`），在已有 `preferences` 中加入：

```json
{
  "preferences": {
    "projectsRootDir": "D:\\feishu-projects"
  }
}
```

也支持绝对路径和 `~/code` 这类路径。请保留配置文件里的其他字段，修改后重启 bridge；该项只影响之后留空路径创建的空白项目，不会移动已有项目，也不影响手动填写的文件夹路径。

---

## ⚠️ 安全须知

机器人跑 agent 始终是 **`approvalPolicy: never`**（无逐条人工审批），**沙箱是唯一的安全闸门**。每个项目在私聊 / 网页控制台里可设三档权限：

| 档位 | 能读 / 能写 | 适用 |
|------|------------|------|
| 🔒 **项目内只读** | 仅项目目录 / 不可写 | 外部群、不可信场景的问答机器人 |
| ✏️ **项目内读写** | 仅项目目录 | 自己的编码项目，禁止它碰机器其余部分 |
| ⚠️ **完全访问** | 整台电脑 | 完全信任、你自己掌控的机器 |

- 🔒 / ✏️ 的读写限定由 OS 沙箱强制，仅 **macOS / 原生 Windows** 可强制；**Linux·WSL 选这两档会 fail-closed 拒绝启动**（绝不静默降级为完全访问），要用请把后端跑在容器 / 隔离环境里。
- dsh 后端无 OS 沙箱概念，**只开放「完全访问」档**，档外 fail-closed —— 只在完全信任的机器上使用。
- ⚠️ **完全访问** = 任何能给机器人发消息的人都能以你的身份在这台机器上执行任意命令 —— 只把信任的人拉进群、在你自己掌控的机器上跑、目录里别放敏感数据。
- 它不是多租户托管服务，是给你（和你信任的小团队）自用的桥。

---

## 🌐 Web 控制台

`feishu-CN-bridge web` 打开本机浏览器里的管理面板（只绑 `127.0.0.1` + 每次启动随机 token 鉴权），一屏搞定：扫码加机器人、开权限 / 订阅事件 checklist、启停 / 重启 / 更新后台服务、看所有 bot / 项目 / 话题 / 实时日志、后端环境检测。daemon 在跑时是可写控制台；没跑时退化为只读预览，仍可一键启动 daemon。日常管理基本只跟它和飞书私聊控制台打交道。

---

## 🧑‍💻 开发

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsup → dist/
npm test            # vitest
```

`git clone https://github.com/xiaocheng-GPT/feishu-cn-bridge.git && cd feishu-cn-bridge && npm i`（`prepare` 自动构建），前台跑 `npm start`。架构与实现见 [`docs/design/feishu-CN-bridge-design.md`](docs/design/feishu-CN-bridge-design.md) 与 [`docs/design/implementation-plan.md`](docs/design/implementation-plan.md)。

每个 PR 自动在 **macOS / Windows / Linux × Node 20 / 22 / 24** 上检查类型、构建并运行测试。Node 24 任务还执行隔离的系统服务启动测试；不需要飞书凭据或模型账号。测试覆盖范围、虚拟机验收步骤及本地运行方式见 [跨平台验证指南](docs/testing/cross-platform-ci.md)。

---

## 💬 文档 & 交流

- 📮 **联系方式 / 反馈 / 交流**：**2129837073@qq.com**

---

## 📄 License

[MIT](LICENSE)

### 语音转文字

给 agent 发语音时，先转为文字再发送给 agent。

网页控制台：选择机器人 → **语音转文字**。飞书私聊控制台：**设置 → 语音转文字 → 去开启 / 去关闭**。

- 开关：开启后自动检查权限，缺少权限时显示 **去授权** 和 **重新检测**；授权并发布应用后，点击重新检测即可刷新权限状态，不上传音频。
- 测试：仅在开启后显示，用内置短音频验证转写并显示结果。
- 若机器人所属租户为飞书免费版，则不支持调用。[飞书 ASR 文档](https://open.feishu.cn/document/server-docs/ai/speech_to_text-v1/file_recognize?lang=zh-CN)

设置即时生效。识别不可用时保留原语音附件交给 agent。agent 接收转写原文，不附加复述要求。
bridge 在回复卡片顶部添加默认展开、可收起的浅灰"语音消息"原文块，流式和最终回复均保留；结果不保证与飞书客户端一致。支持 60 秒、20 MB 以内的纯语音。
Windows/macOS 无需额外安装 ffmpeg 或 Python。