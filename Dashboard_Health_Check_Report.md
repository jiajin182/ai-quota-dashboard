# M5 AI 用量看板：体检报告

> **报告日期：2026-10-11。** 范围：只检查、不修改（本轮未改动任何代码）。
> 对象：`dashboard/` 采集服务（Node.js，无三方运行依赖）+ `public/index.html` 看板 + Docker 部署制品。
> 结论：**数据显示正常（6/6 数据源可用）**；发现 6 项待优化问题（2 项建议修、4 项可选）；并排除 3 项误报怀疑。

---

## 0. TL;DR

- 数据链路健康：6 个数据源全部 `ok=true`，数值与上游平台一致，看板渲染无错位、无空白卡。
- **建议修**：
  - P1 Qoder 卡进度条百分比与同卡文字口径差 1pp（卡内自相矛盾）；
  - P2 `docker-compose.yml` 缺 `data/` 挂载，容器重建会丢 WorkBuddy「当日消耗」基线。
- **可选**：P3 到期积分逻辑重复 + 文档漂移；P4 静态目录前缀校验加固；P5 DeepSeek `month` 字段采集未用；P6 描述/文档漂移。
- **已排除（勿误修）**：Codex 孤儿进程泄漏（不成立）、Qoder `resetsAt` 过期（设计行为）、MiMo/WorkBuddy 今日为 0（真实数据）。

---

## 1. 验证环境与方法

- 环境：Windows 本机，Node v24.20.0；服务监听 `0.0.0.0:8787`（`config/service.json`）。
- 凭据：全部复用服务端 `config/` 现有只读凭据，未新增、未导出任何令牌。
- 步骤：
  1. `node --check` 校验 `server.js` / `collector.js` / `trae-token.js`；
  2. 直连 5 个非 Codex 采集函数实测返回；
  3. 启动 `node server.js`，拉取 `/api/usage` 与 `/api/usage?source=codex` 全量核对（含真实 `codex app-server`）；
  4. 浏览器打开 `http://127.0.0.1:8787/` 截图，逐卡核对渲染结果与接口数值；
  5. 进程复查：采集前 / 采集后立即 / 采集后 8s，以及服务持续运行、多次采集后，检查 codex 残留进程。
- 收尾：验证后已停止服务、删除全部临时验证脚本，项目目录无残留。

---

## 2. 数据显示核对（实测值，2026-10-11 17:38 本地时间）

| 卡片 | 看板显示 | 接口原始值 | 结论 |
| --- | --- | --- | --- |
| Codex 额度 | 每月窗口 剩余 100% · 已用 0% · 重置 2026/11/10 17:38 | `planType=free`；单窗口 `windowDurationMins=43200`、`usedPercent=0` | ✅ 免费套餐单窗口，与 app-server 返回一致 |
| DeepSeek | 余额 ¥5.18 · 今日消费 ¥0.5103 · 93 次 · 336,668 tokens（命中 63.6K / 未命中 194.4K / 输出 78.7K） | `total_balance="5.18"`；`today.cost=0.51031332`、`requests=93`、`tokens=336668` | ✅ 三个分项之和恰等于总数，自洽 |
| WorkBuddy | 剩余 1,681 · 当日消耗 0（估算）· 最近到期 2026/11/1 积分 108 | `totalRemain=1681`、`totalUsed=2173.78`、47 个积分包 | ✅ 108 = 8 + 100（两个同日到期包），正确 |
| TRAE | 剩余 2,484.76 · 已用 1,165.24 / 3,650 · 最近到期 2026/10/22 积分 34.76 | `totalLimit=3650`、`totalUsed=1165.24`、`totalRemain=2484.76` | ✅ |
| Xiaomi MiMo | 余额 ¥1.48 · 月度额度剩余 62.9%（1521M / 4100M）· 今日 0 用量 / ¥0 | `quota.used=1521498484`、`limit=4100000000`；`balance.total=1.48`；今日明细全 0 | ✅ 今日确无调用，非采集失败 |
| Qoder CN | 剩余 68% · 已用 403 / 1,300 · 剩余 897 · 最近到期 2026/10/29 积分 10 | `used=403`、`total=1300`、`remaining=897`；接口 `usage_percentage=32` | ⚠️ 数值正确，但百分比口径不一致，见 P1 |

> 注：Qoder 数值在验证期间由 329 → 403，因本会话实际消耗 Credits，属正常实时变化，非采集异常。

---

## 3. 问题清单

### P1（建议修）Qoder 百分比口径不一致，卡内自相矛盾

- **现象**：进度条与「剩余 %」使用接口返回的 `usage_percentage`，与同卡「已用 x / y」「剩余 z」按 `used/total` 实算的口径相差 1 个百分点。卡上同时出现「剩余 68%」与「剩余 897 credits」（897/1300 = 69%），自相矛盾。
- **实测**：`used 403 / 1300 = 31.00%`，接口 `usage_percentage = 32`，偏差 +1.00pp。
- **位置**：`dashboard/collector.js:1145-1147`（无共享包时信任 `base.provided`）；`dashboard/public/index.html:345-347`。
- **建议**：无共享包时也按 `used/total` 计算 `usedPercent`（或让进度条与文字共用同一计算来源）；接口值可保留作对照但不直接上屏。

### P2（建议修）docker-compose 缺 `data/` 持久化挂载

- **现象**：容器重建后 `data/workbuddy-state.json` 丢失，WorkBuddy「当日消耗」基线归零、当日消耗从头累计。
- **位置**：`dashboard/docker-compose.yml:13-18`（volumes 仅 `.codex` 与 `config` 两处）。
- **依据**：`Ubuntu_Node_Deploy_Guide.md` §5.2 已给出建议改法，尚未落地到 compose 文件。
- **建议**：增加 `- ./data:/app/data`。**部署到 ub 节点前完成此项。**

### P3（可选）WorkBuddy 到期积分逻辑重复 + 文档漂移

- **现象**：`dashboard/public/index.html:212-235` 是 `expirySummary()`（`index.html:117-139`）的完整复制；TRAE / Qoder 调用函数版，WorkBuddy 却用内联副本，两份逻辑完全等价。
- **文档不符**：`Dashboard_Data_Modules.md` §9 声称「到期积分提示（expirySummary，WorkBuddy/TRAE/Qoder 共用）」，与代码不符。
- **建议**：`renderWorkbuddy` 改调 `expirySummary(w.packExpiry)` 并删除内联副本；同步订正文档或代码二者之一。

### P4（可选，加固）静态目录前缀校验缺分隔符边界

- **位置**：`dashboard/server.js:279`，`full.startsWith(path.join(ROOT, 'public'))`。
- **现状**：不可利用（当前无 `public*` 同级目录）。
- **潜在**：若将来新增如 `public-data/`，请求 `/../public-data/x` 归一化后仍以 `...\public` 为前缀，可通过校验被读出。
- **建议**：改为 `full === pubDir || full.startsWith(pubDir + path.sep)`。

### P5（可选）DeepSeek `month` 字段采集但前端未渲染

- **位置**：`dashboard/collector.js:266-275` 产出 `month`（本月累计 tokens/requests/cost）；`index.html` 的 `renderDeepseek` 未使用。
- **建议**：在 DeepSeek 卡加一行「本月累计」展示，或删除该字段以减少无用计算与传输。

### P6（可选）描述与文档漂移

- `dashboard/package.json:4` 的 description 仍为「Codex 额度 + DeepSeek 余额/今日用量」，实际已扩展为 6 个数据源。
- `dashboard/.dockerignore` 未列 `data`；而 `Ubuntu_Node_Deploy_Guide.md` §5.1 称「config/ 与 data/ 被 .dockerignore 排除」，与文件不符（当前 Dockerfile 用显式 COPY，无实际影响）。

---

## 4. 已验证排除的怀疑（避免误修）

1. **Codex 孤儿进程泄漏 —— 不成立。**
   - 起因：合成测试（以 `node -e setTimeout` 假进程模拟）显示 `shell:true` + `proc.kill()` 不会终止孙进程，一度怀疑每次刷新泄漏一个 `codex app-server`。
   - 复测：对真实 `codex app-server` 在采集前 / 采集后立即 / 采集后 8s 三次检查进程表，并在服务持续运行、多次采集后复查，**均无残留进程**。
   - 结论：`dashboard/collector.js:60` 的 `proc.kill()` 现状够用。提醒：该机制依赖子进程自行退出，若更换 shell 命令或部署到行为不同的环境需重测。
2. **Qoder `resetsAt` 返回 2026-09-10（早于当前时间）—— 设计行为。** 前端按 `index.html:353` 的判断隐藏「重置于」，符合 `Huawei_M5_AI_Usage_Dashboard_Research.md` §12.3 记录的已知平台行为，非缺陷。
3. **MiMo 今日用量全 0、WorkBuddy 当日消耗 0 —— 真实数据。** 当日尚未产生消耗，非采集失败。

---

## 5. 其他观察（不影响正确性）

- WorkBuddy 徽章在接口 `planName` 为 null 时显示「积分」，信息量低；若接口长期不返回 PlanName，可考虑显示包数量或留空。
- 窄屏（约 <700px）下 MiMo 卡标题与徽章换行较挤；平板 1600px 宽下正常，可忽略。
- 静态资源未设置 Cache-Control；若平板 WebView 启用启发式缓存可能拿到旧 `index.html`，可对 index.html 增加 `Cache-Control: no-cache`。

---

## 6. 结论与后续

- 数据显示正常，看板可继续用于平板展示，并具备部署到 ub 节点的条件。
- 建议修复顺序：**P2（部署前必做）→ P1 → P3 → P4/P5/P6**。
- 本报告仅记录结论，未修改任何代码；具体修复需另行确认后执行。

---

## 7. 第二轮复查（修复后，2026-10-11 18:00 前后）

> P1–P6 的修复由用户自行完成（17:47–17:48 改动 6 个文件）。本轮仅复查，未改代码。
> 注意：复查期间 8787 端口由用户自启实例（PID 35664，17:50 启动）占用，本节接口数据均取自该实例（已运行修复后代码）；复查方自身启动的实例因 EADDRINUSE 未生效。

### 7.1 P1–P6 复查结果：全部确认修复

| 项 | 复查证据 |
| --- | --- |
| P1 Qoder 口径 | `usedPercent` 改为按 `used/total` 实算（`collector.js:1144-1146`）。实测 used 496 / 1300 → 38.15%，与 `remainingPercent` 61.85%、`remaining` 804 完全自洽，卡内不再矛盾 |
| P2 data 持久化 | `docker-compose.yml` 已增加 `- ./data:/app/data` |
| P3 逻辑去重 | `renderWorkbuddy` 改调 `expirySummary(w.packExpiry)`（`index.html:217`），原内联副本已删除 |
| P4 目录校验 | `serveStatic` 改为 `full !== pubDir && !full.startsWith(pubDir + path.sep)` 才拒绝（`server.js:281`） |
| P5 month 展示 | DeepSeek 卡新增「本月累计」行（`index.html:198-199`）；实测 `month={requests:102, tokens:422020, cost:0.6113}` |
| P6 描述/文档 | `package.json` description 已列 6 个数据源；`.dockerignore` 已加 `data` |

语法检查 3 个 JS 文件通过；该实例中其余 5 个数据源均 `ok=true`，看板渲染正常，未见回归。

### 7.2 新发现问题 P7：运行实例中 Codex 卡持续失败（命令解析依赖启动 shell 的 PATH）

- **现象**：用户实例（PID 35664）中 codex 恒为 `ok=false, error="app-server 提前退出（code 1）"`，`?source=codex` 强制刷新亦无效；同机直连 `collectCodex()` 却 `ok=true`。平板（<平板IP>）正连接该实例，故平板 Codex 卡当前显示采集失败。
- **根因**：该实例进程的 PATH 不含 `C:\Users\<用户名>\AppData\Roaming\npm`；`spawn("codex app-server", {shell:true})` 经 `cmd /c` 解析命令失败、退出码 1。collector 丢弃 stderr（`collector.js:68` 的 `stdio[2]='ignore'`），把「命令找不到」误报为「app-server 提前退出（code 1）」——与凭据手册中「~/.codex 不可访问」的症状文案相同，易误导排障方向。
- **证据链**：① 剥离 npm 目录的 PATH 可复现同一报错与退出码；② 同一环境下 `codex --version` 与以绝对路径手动运行 app-server 均正常；③ `collectCodex({codexPath:"C:/Users/<用户名>/AppData/Roaming/npm/codex.cmd"})` 在剥离 PATH 下 `ok=true`。
- **修复（配置级，一行）**：`config/codex.json` 的 `codexPath` 改为绝对路径 `C:\Users\<用户名>\AppData\Roaming\npm\codex.cmd`，然后重启该实例。改后不再依赖启动 shell 的 PATH，对开机自启 / 计划任务等场景更稳。
- **可选代码改进**：将 stderr 改为 pipe 保留；当「stdout 无任何 JSON 且退出码非 0」时报告「codex 命令不可用（检查 PATH 或 config/codex.json 的 codexPath）」，与登录态 / 目录问题区分。

### 7.3 复查结论

- P1–P6 修复有效，未引入回归。
- 遗留 P7 一项：属配置 / 环境问题，非本轮代码修复引入；按 7.2 的一行配置即可恢复 Codex 卡。
