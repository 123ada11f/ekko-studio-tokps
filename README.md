# ekko-studio-tokps

给 **Ekko Studio**（Hermes Studio 桌面端）/ 任意 Electron 客户端的聊天界面加一个**实时 tok/s 浮标**：
流式生成时就跳动，不用等这一轮结束；点开还有 模型用时 / 工具用时 / 首 token 延迟 / token 明细 / 速率曲线 / 每轮历史。

> 背景：Studio 桌面端自带的 webui 把运行统计留在了新版本里，老版本界面上看不到输出速度。
> 这个项目**不修改应用代码**（只注入一个独立脚本），并且**不常驻后台**。

```text
● 生成中 · ~188 tok/s · 首字 1.8秒 · 轮 5 · 步 12 · 上下文 7.3%
```

## 特性

- **实时**：每来一个 delta 就按流式文本粗估 token（口径同 DSH 的 `dsh-working-activity`：CJK ×1.5、其他 ÷4，去掉空白），
  窗口下限 1 秒；最后一个 chunk 超过 3.5 秒没有新内容就隐藏实时值 —— 显示成 `~N tok/s` 表示估算。
- **实测校准**：一旦拿到 `usage` 里的真实输出 token，就用 `实测 / 估算` 做滑动校准，实时值立刻更准。
- **形态无关的取数**：socket.io 帧、`{event,payload}` 封装、裸 WebSocket JSON、**NDJSON 流（`/chat-run`）**、SSE、
  事件名别名（`stream.delta` / `assistant_delta` / `MESSAGE_DELTA` …）、文本字段兜底（认不出字段名就取最长的非元数据字符串）。
- **结算兜底**：即使整轮完全没有 `usage` 数据，也会用估算给出 `~N tok/s`，不会显示「—」。
- **诊断区**：面板底部显示 `已捕获 N 帧 · M 事件` 与 `最近事件: 名字 · 字段名…`，取不到数时一眼看出卡在哪。
- **不常驻后台**：没有任何服务/计划任务；只在「打补丁 / 启动 / 还原」这三个你主动触发的时刻运行。
- **升级不失效**：用自带启动器打开 Studio 时自动重打补丁；或改用下面的 CDP 运行时注入（完全不碰文件）。

## 三种接入方式

| 方式 | 改文件？ | 升级后 | 需要重启应用？ | 说明 |
|---|---|---|---|---|
| **A. 文件注入 + 启动器**（默认） | 改 1 行 `index.html` + 放 1 个 js | 用启动器打开即自动重打 | 首次需 Ctrl+R 或重开 | 最稳，已验证；升级覆盖后由启动器修复 |
| **B. CDP 运行时注入** | 不改任何文件 | 天然不受升级影响 | 需要先关掉 Studio（Electron 单实例） | `--remote-debugging-port` + `Page.addScriptToEvaluateOnNewDocument`，注入只在内存里 |
| C. 自己写个后台监控定时重打 | 改文件 | 自动重打 | 无需 | 本文不推荐：常驻进程，没必要 |

## 用法

```bash
python studio_tokps.py status                 # 看状态：安装目录 / 版本 / 是否已注入 / 前端是否自带统计
python studio_tokps.py launch                 # 打补丁并启动 Studio（日常就用这个）
python studio_tokps.py apply                  # 只打补丁，稍后自己在窗口里 Ctrl+R
python studio_tokps.py launch --cdp           # 运行时注入（不碰文件；会先检查 Studio 是否在跑）
python studio_tokps.py cdp --restart          # 关掉正在运行的 Studio，用调试端口重启并注入
python studio_tokps.py revert                 # 还原
python studio_tokps.py status --app "D:\path\to\Ekko Studio"   # 手动指定安装目录
```

Windows 直接双击 `studio-tokps.cmd`（等价于 `launch`，支持同样参数）；macOS / Linux 用 `./studio-tokps.sh`。
安装目录默认自动探测：先看正在运行的进程路径，再扫各盘常见位置，最后按名字兜底 —— 探测不到就用 `--app` 指定。

## 升级后怎么办

- 用 `studio-tokps.cmd` / `studio-tokps.py launch` 打开 Studio：**每次启动都会重打补丁**，所以整包升级后照样生效。
- 直接从开始菜单打开 Studio（没走启动器）：补丁可能在升级时被覆盖，此时跑一次 `launch` 或 `apply`，再 Ctrl+R。
- 想彻底不受升级影响：用 `launch --cdp`（方式 B），运行时注入，文件零改动。

## 数据来源与口径

事件流只读嗅探（包裹 `WebSocket` / `fetch` / `XMLHttpRequest`），不改变应用行为：

| 指标 | 来源 | 说明 |
|---|---|---|
| 首 token 延迟 | `run.started` → 第一个 delta | |
| 模型用时 / 工具调用用时 | 各次模型调用、工具调用的时间戳累加 | 窗口按**单次模型调用**（不是整轮），工具时间不计入分母 |
| 输出速度 | 实测：本轮输出 token ÷ 模型用时；实时：估算 token ÷ 流式窗口 | 带 `~` 为估算 |
| 缓存命中率 | `cache_read_tokens / (input_tokens + cache_read_tokens)` | |
| 上下文占用 | `contextTokens`，上限读 `/api/studio/sessions/:id/context` | 取不到上限时只显示已用 token |

**精度说明**：Studio 部分版本的后端不上报计时，所以实时值属**估算**（面板底部有标注）；实测值来自 `usage`，与官方统计口径一致。


## 官方 usage 接入（v3.4）

浮标除了嗅探事件流，还会读 Studio 自己的会话接口（同一进程内发请求，带应用自身凭据）：

```
GET /api/studio/sessions/:id      → { session: { input_tokens, output_tokens, cache_read_tokens,
                                                 cache_write_tokens, reasoning_tokens,
                                                 message_count, tool_call_count,
                                                 started_at, ended_at, model, … } }
GET /api/studio/sessions/:id/usage → 最近一条 usage 行（token 明细）
```

由此得到**真实**数值（不再是估算）：

| 显示项 | 算式 |
|---|---|
| 官方 usage 区块 | 直接来自会话行：输入/输出/缓存读/写/推理/message_count/tool_call_count/模型 |
| 缓存命中率（真实） | `cache_read_tokens / (input_tokens + cache_read_tokens)` |
| 会话时长 / 平均 TPS | `output_tokens ÷ (ended_at − started_at)`（含工具等待，所以会明显低于瞬时速度，面板里标注为「平均」，浮标上带「平均」前缀） |
| 实测速度（本轮·接口口径） | `(本轮结束时的 output_tokens − 本轮开始时的 output_tokens) ÷ 事件流测得的模型用时` |

**这对"运行时不上报 usage 事件"的版本尤其有用**：以前那种情况只能显示估算值，现在有真实 token 兜底。
读取失败（未登录 / 接口变化）时面板会明确写「未接入（原因）」，并回退到事件流统计。

## 自检

```bash
node test/parser.test.mjs                        # 解析/计算逻辑（Node 内置 vm 里跑 overlay，无需应用）
node --check tokps-overlay.js && node --check inject-cdp.mjs
python -m py_compile studio_tokps.py dev/ndjson-test-server.py
python dev/ndjson-test-server.py                 # 起一个假 /chat-run NDJSON 流（127.0.0.1:8899），
                                                 # 在 Studio 页面控制台 fetch 它即可看到浮标跳动
```

CI（`.github/workflows/ci.yml`）跑上面这些语法检查与解析测试。

## 已知限制

- 只对 **Electron/Chromium 界面**有效（Studio、Hermes Studio 等）。
- 前端若被搬进 `app.asar` 或改了目录结构，文件注入会明确报错而不是乱猜；此时用方式 B。
- 估算值受文本构成影响（中英混排、代码块），读数以面板里的「实测速度」为准。
- 不要用它去改别人产品的付费/鉴权逻辑 —— 这里只做「本地显示增强」。


## 上游进展（Upstream）

- **Issue #3178**（open）：聊天界面缺 tok/s 与缓存命中率，官方桌面端状态栏已有、来源是 TUI 网关的 `avg_tps` / `cache_hit_pct`。
  我们在该 issue 下贴了本项目的思路与实测到的协议细节：
  https://github.com/EKKOLearnAI/ekko-studio/issues/3178#issuecomment-5892455675
- **PR #3227**（open，MERGEABLE）：把社区 PR **#2713**（作者 @monikalnbo，自 2026-08-23 起 CONFLICTING）基于当前 `main` 重新变基，
  保留原作者署名，并修掉两处无法构建的问题（`ChatInput.vue` props 冲突取并集；移除引用不存在导出的 `noteRunStart(sid)` 调用）。
  改动仍为纯新增 `+180/-0`、15 文件。
  https://github.com/EKKOLearnAI/ekko-studio/pull/3227

本仓库是**不依赖上游合并、现在就能用**的补丁版本；上面那个 PR 是"做进产品里"的路径。两者可以并存。

## License

MIT，见 [LICENSE](LICENSE)。
