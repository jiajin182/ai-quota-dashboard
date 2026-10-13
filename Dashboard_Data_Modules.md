# 看板数据模块说明：获取与计算

本文件逐个模块记录 M5 AI 用量看板的**数据获取方式**（接口、鉴权、关键字段）与**计算逻辑**
（后端如何把原始响应算成卡片字段、前端如何再汇总展示）。凭据的获取步骤另见
[Credentials_Guide.md](file:///e:/AIProjects/HUAWEI_M5/Credentials_Guide.md)，本文件只说明
“拿到凭据之后，数据怎么取、怎么算”。

> 代码位置：采集逻辑 [`dashboard/collector.js`](file:///e:/AIProjects/HUAWEI_M5/dashboard/collector.js)、
> 聚合与刷新 [`dashboard/server.js`](file:///e:/AIProjects/HUAWEI_M5/dashboard/server.js)、
> 渲染 [`dashboard/public/index.html`](file:///e:/AIProjects/HUAWEI_M5/dashboard/public/index.html)。
> 卡片上出现的每个数值都应能在本文件中找到来源公式。

## 0. 总览

数据流：**collector 采集 → server 缓存/聚合 → index.html 渲染**。平板只拉取聚合后的只读 JSON，
所有凭据仅存于服务端 `config/`。

| 卡片（source） | 数据要点 | 鉴权方式 | 采集函数 | 配置文件 |
| --- | --- | --- | --- | --- |
| Codex 额度 `codex` | 套餐、额度窗口已用/剩余、重置时间 | ChatGPT OAuth 登录态（`~/.codex/auth.json` 复制为 `config/codex.json`） | `collectCodex` | `config/codex.json` |
| DeepSeek `deepseek` | 余额 + 今日消费/请求数/Tokens | API Key（余额）+ 网页 `userToken`（用量） | `collectDeepseek` / `collectDeepseekUsage` | `config/deepseek.json` |
| WorkBuddy `workbuddy` | 积分剩余、当日消耗、到期积分 | 登录态 `accessToken` + `uid` | `collectWorkbuddy` | `config/workbuddy.json` |
| TRAE 积分 `trae` | 积分额度、剩余、到期积分 | 登录态 `Cloud-IDE-JWT` | `collectTrae` | `config/trae.json` |
| Xiaomi MiMo `mimo` | 今日用量、月度额度、余额 | 网页登录态 Cookie | `collectMimo` | `config/mimo.json` |
| Qoder CN `qoder` | 大模型 Credits 用量、剩余 | 网页登录态 Cookie | `collectQoder` | `config/qoder.json` |
| MiniMax 余额 `minimax` | 账户余额（可用/现金/代金券/积分/欠费） | **官方公开接口**，按量付费 API Key | `collectMinimax` | `config/minimax.json` |

## 1. 跨模块通用约定

- **只读**：所有采集均为只读；不写入、不改动上游账户数据。Codex 只读取本地凭据里的
  `access_token` 查询额度，不外发、不写回、不续期。
- **“HTTP 200 也可能是失败”**：DeepSeek、WorkBuddy、TRAE、MiMo、Qoder 的平台内部接口在鉴权
  失败时**仍可能返回 HTTP 200**，错误放在响应体的 `code` / `biz_code` 里。因此采集端一律先判
  `code`，再判 HTTP 状态，避免把过期令牌误判成“零用量”。MiniMax 同属此类（错误放在 `base_resp.status_code`），
  但其错误状态码可能是 HTTP 400 而非 200，故同样以响应体判定为准。
- **鉴权失效识别**：`wbIsAuthError()` 用 `token|auth|登录|过期|未授权|失效|401|403` 判定为登录态
  失效，返回 `authExpired:true`，前端提示“重新获取”。
- **配置按产品拆分**：服务级共享项在 `config/service.json`，各产品各一个文件，禁止混写。
- **两种命名字段都探测**：国内平台内部接口普遍用 snake_case（`used_value`/`limit_value`），
  国际版/社区参考常用 camelCase（`usedValue`/`limitValue`），解析器同时探测两种写法。

## 2. Codex 额度

### 2.1 获取

读 `config/codex.json`（内容即 `~/.codex/auth.json`，含 `tokens.access_token` / `tokens.account_id`），
直接请求 ChatGPT 用量接口：

- `GET https://chatgpt.com/backend-api/wham/usage`
- 请求头：`Authorization: Bearer <tokens.access_token>`、`ChatGPT-Account-Id: <tokens.account_id>`、
  `Accept: application/json`，并镜像 codex CLI 的 `User-Agent`（`codex_cli_rs/...`）。
- 超时 15s；**不依赖 codex 二进制、不写回、不调用 OAuth 续期**。
- 先本地解析 `access_token` 的 JWT `exp`（不验签）：已过期直接返回「登录态已过期」；
  HTTP 401/403 返回「凭据被拒绝」。

### 2.2 关键字段与计算（`normalizeCodex`）

- 取值来源：`rate_limit` 下的 `primary_window` / `secondary_window`，仅当 `used_percent` 为数字时计入：
  - `windowMinutes` = `round(limit_window_seconds / 60)`；`label` 由 `labelForWindow()` 映射：
    `300→5 小时窗口`、`10080→每周窗口`、`43200→每月窗口`、`1440→每日窗口`，其余为 `${N} 分钟窗口`。
  - `usedPercent` = 原值；`remainingPercent` = `clamp(0..100, 100 - usedPercent)`。
  - `resetsAt` = `epochToIso(reset_at)`（**秒/毫秒双判**：> 1e10 视为毫秒，否则按秒 ×1000）。
- 同时带出 `planType`（= `plan_type`）、`credits`、`resetCredits`（= `rate_limit_reset_credits.available_count`）。
- **不硬编码窗口时长**：按接口返回的 `limit_window_seconds` 解释，故免费账号（单个月窗口）
  与付费账号（5h+周双窗口）同一套代码兼容。

### 2.3 前端（`renderCodex`）

每窗口一行：`剩余 {remainingPercent}%` + 进度条（宽度=remainingPercent，颜色见 §9）+ `已用 {usedPercent}% · 重置于 {resetsAt 本地时间}`。

## 3. DeepSeek（余额 + 今日用量）

DeepSeek 是**两条独立链路**，缺一条只影响对应部分：

### 3.1 余额（官方 API，`collectDeepseek`）

- `GET https://api.deepseek.com/user/balance`，头 `Authorization: Bearer <deepseekApiKey>`。
- 取 `is_available` 与 `balance_infos[]`（数组，前端用第一项的 `currency`/`total_balance`）。
- 无 Key 直接返回“未配置”。

### 3.2 用量（平台内部接口，`collectDeepseekUsage`）

- 基础地址 `https://platform.deepseek.com/api/v0/usage`，头
  `Authorization: Bearer <deepseekPlatformToken>` + `x-client-platform: web`。
- 并行取两个接口（参数为**当前年月**）：
  - `GET /amount?month=&year=` → 按天、按类型的用量明细；
  - `GET /cost?month=&year=` → 按天费用明细。
- **响应外层为 `{code, data:{biz_code, biz_data}}`**：`platformEnvelopeError()` 先判 `code`、再判
  `data.biz_code`，非 0 视为失败；若错误含 `token|auth` 或 `code===40003`，追加“用量 Token 无效或已过期”提示。

**计算（`summarizePlatformDays`）**：把两个接口按**日期**归并成 `Map<date, {tokens, cacheHit, cacheMiss, response, requests, cost}>`：

| 明细 `usage[].type` | 累加到 |
| --- | --- |
| `PROMPT_CACHE_HIT_TOKEN` | `cacheHit` 与 `tokens` |
| `PROMPT_CACHE_MISS_TOKEN` | `cacheMiss` 与 `tokens` |
| `RESPONSE_TOKEN` | `response` 与 `tokens` |
| `REQUEST` | `requests` |
| cost 接口各天 `usage[].amount` | `cost` |

> `amount` 的 `biz_data` 是对象 `{total, days}`；`cost` 的 `biz_data` 是数组，取第一个含 `days` 的块。
> `currency` 取该块的 `currency`，缺省 `CNY`。

- `today` = `byDate[今日本地日期]`，无记录时各项为 0；`month` = 所有日期累加 `{tokens, requests, cost}`。
- **仅映射上述 4 种 type**，其余类型（如 `PROMPT_TOKEN`）当前不计入。

### 3.3 前端（`renderDeepseek`）

- 汇总行：`余额 {币种符号}{total_balance}` · `今日消费 {fmtMoney(today.cost)}`。
- “今日用量”区：`API 请求次数`=today.requests、`Tokens`=today.tokens，
  附注 `缓存命中 / 未命中 / 输出`（Tokens 该项用 K/M 缩写格式化）。

## 4. WorkBuddy 积分

### 4.1 获取（`collectWorkbuddy`）

- 域名取 `config` 的 `domain`（默认 `www.workbuddy.cn`），逐条尝试两条路径：
  1. `POST /v2/billing/meter/get-user-resource`（实测返回 `data.Response.Data.Accounts[]`）；
  2. `POST /billing/meter/get-user-resource-summary`（回退）。
- 头 `Authorization: Bearer <accessToken>` + `X-User-Id: <uid>`，体 `{}`。
- `404` 视为该路径不适用 → 试下一条；`401/403` 或 `code/biz_code` 判为鉴权失效直接返回。
- 令牌过期且配置了 `refreshToken` + `refreshUrl` 时，服务端续期一次并**原子回写** `workbuddy.json` 后重试（默认关闭）。

### 4.2 关键字段与计算（`wbNormalizePackages`）

账户数组来源兼容 `Accounts/Packages/Resources/Items/List` 及 `data.Response.Data`、`data.Data`、`data` 三种根。
每个积分包逐键探测（**顺序即优先级**）：

| 目标 | 探测键（按序） |
| --- | --- |
| `total` | `CapacitySize`、`CycleCapacitySize`、`CycleTotalCapacity`、`Capacity`、`TotalCapacity`、`Total`、`Quota`、`total` |
| `used` | `CycleCapacityUsedPrecise`、`CycleCapacityUsed`、`CycleUsedCapacity`、`CapacityUsed`、`Used`、`UsedAmount`、`used` |
| `remain` | `CapacityRemain`、`CycleCapacityRemainPrecise`、`CycleRemainCapacity`、`Remain`、`Remaining`、`Available`、`Balance`、`remain`；缺省用 `total - used` |

> 实测关键点：额度字段真实名为 **`CapacitySize` / `CycleCapacitySize`**（并非 `Capacity`/`Total`/`Quota`）；
> 且体验版 `CapacityUsed` 恒为 0，只有 **`CycleCapacityUsed*`** 反映真实消耗。

- `totalRemain` = `Σ remain`（四舍五入 2 位）；`totalUsed` = `Σ used`。
- **当日消耗（快照估算，`withWorkbuddyDaily`，在 server.js）**：平台只有周期粒度用量、无日期粒度，
  故以“当日首次读数”为基线做差：状态存 `data/workbuddy-state.json`；跨天或读数回退
  （换包/到期）时重置基线、`todayUsed=0`，否则 `todayUsed = 当前 totalUsed − 基线`；始终标记
  `todayUsedEstimated=true`（前端显示“（估算）”）。
- **到期积分（`wbPackExpiry`）**：对每个 `remain>0` 的包，按客户端 edge-sync 规则取到期时间：
  - 从 `PackageCode` 解析序号（`code_(\d+)`）；
  - `code_002/003/005/008/023/026/027/028/035/037/039/040` 为“只每月刷新、不到期”→ **不计入**；
  - `code_001`（每日包）到期时间取 `CycleEndTime`，其余取 `DeductionEndTime`（无效再兜底 `CycleEndTime`）；
  - 输出 `{until, remain}[]` 供前端汇总。

### 4.3 前端（`renderWorkbuddy`）

`剩余积分 {totalRemain}` + `当日消耗 {todayUsed}（估算）` + 到期积分提示（见 §9 `expirySummary`）。

## 5. TRAE 积分

### 5.1 获取（`collectTrae`）

- `POST https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage`，头 `Authorization: Cloud-IDE-JWT <token>`
  （可选带 `x-device-id` / `x-machine-id`），体 `{require_usage:true, req_source:0}`。
- 响应为**扁平结构**（可能无 `code/data` 包裹）；兼容 `{data:{...}}` 形态。
- **刻意不自动续期**：TRAE 的 `ExchangeToken` 会轮换整个令牌族、踢掉其它客户端登录态，故只做只读使用。

### 5.2 计算

- 聚合用量在 `usage_summary`：
  - `totalAmount` = `total_amount`；`consumed` = `consumed_amount`；
  - `unlimited` = `totalAmount === -1`；
  - `totalLimit` = 非不限量且 `>0` 时取 `totalAmount`，否则 0；
  - `totalUsed` = `consumed || 0`；
  - `totalRemain` = `totalLimit>0 ? max(0, totalLimit − totalUsed) : null`。
- `packs`（`traeGroupPacks`）：按包名（`display_desc` 等）分组，`used` 为该组 `Σ usage.credits_amount`，
  `activeCount` 为 `status==null||1` 且未过期（`expire_time > 当前秒`）的包数，`until` 取组内最早 `expire_time`。
- `packExpiry`（`traePackExpiry`）：每包 `remain = max(0, credits_limit − credits_amount)`，
  其中 `credits_limit` 取自 `entitlement_base_info.quota.credits_limit`，到期时间为 `expire_time`（秒）。
- `plan` = `is_credits_billing ? 'Credits' : 'Free'`。

> 语义要点：每包 `usage.credits_amount` 是**已消耗**（各包之和 ≈ `usage_summary.consumed_amount`），
> **不是额度**；额度总量只在 `usage_summary.total_amount` 里。

### 5.3 前端（`renderTrae`）

- `unlimited`：显示“额度 不限量”。
- 有额度：`剩余 {totalRemain}` + 进度条（剩余占比）+ `已用 {used} / {limit} credits` + 到期提示。
- 无额度：`已用积分 {used}` + `剩余 {remain} · {到期提示}`。

## 6. Xiaomi MiMo

### 6.1 获取（`collectMimo`）

- Cookie 先整形（`normalizeMimoCookie`）：仅保留 `api-platform_serviceToken`、`userId`、
  `api-platform_ph`、`api-platform_slh`，丢弃其它；拒绝含换行的值；缺前两者即报错。
  `api-platform_ph`（去引号）需作为 **POST 的 query 参数**，否则 401。
- 头含按本机时区生成的 `x-timeZone`（如 `UTC+08:00`），平台据此划分“本月”。
- 并行请求 5 个子接口（各自独立容错，单个失败不影响其余）：

| 子接口 | 用途 | 关键解析 |
| --- | --- | --- |
| `GET /tokenPlan/usage` | 月度额度 | `monthUsage.items` 找 `name==='month_total_token'`，取 `used`/`limit` |
| `GET /tokenPlan/detail` | 套餐 | `planName`/`planCode`/`expired` |
| `GET /balance` | 余额 | `balance`（总）/`cashBalance`/`giftBalance`/`currency` |
| `GET /usage/detail?year=&month=` | 今日用量 | `tokenUsage` 行 `[MM-DD, 输入, 输出, 总计, 缓存命中]`、`requests` 行 `[MM-DD, 次数]` |
| `POST /usage/detail/list?api-platform_ph=` | 今日消费 | 行含 `date(YYYY-MM-DD)`、`consumedAmount`、`currency` |

- 响应统一 `{code, data}`，`code!==0` 或 `data` 缺失判失败；`30x` 重定向到登录页视为 Cookie 失效。
- 全部子接口都失败才返回 `ok:false`；否则 `ok:true` 并把失败项放进 `errors[]`。

### 6.2 计算

- **月度额度**：`remainingPercent = clamp(0..100, 100 − used/limit×100)`；`limit<=0` 视为无月度额度
  （按量付费账号无此项），置 `quota=null`；套餐 `expired` 时也置空额度。
- **今日用量**：日期键为本地时区 `MM-DD`，取其一行；无调用各项为 0。
  `cacheMiss` 仅在 `input >= cache` 时给出 = `input − cache`（输入 Token 已含缓存命中部分）。
- **今日消费**：`usage/detail/list` 按 `date` 求和，取今天（`YYYY-MM-DD`）的值；
  金额只含**按量计费**部分，套餐额度内的调用不计费、不出现（故订阅账号额度内日子里为 `¥0`）。

### 6.3 前端（`renderMimo`）

- 顶部汇总：`总余额 / 现金余额 / 赠送余额 · 今日消费`（金额≤4 位小数并去尾随 0）。
- 月度额度：`剩余 {remainingPercent}%` + 进度条 + `已用 {used} / {limit}`（K/M 缩写）；
  无额度时提示“按量付费账号无此项”。
- “今日用量”：`API 请求次数`、`Tokens`，附注 `缓存命中 / 未命中 / 输出`。

## 7. Qoder CN

### 7.1 获取（`collectQoder`）

- 域名按 `site` 选：`cn → https://qoder.com.cn`、`intl → https://qoder.com`；接口
  `GET {origin}/api/v2/me/usages/big_model_credits`。
- Cookie 只做基础整形（`normalizeQoderCookie`）：支持纯 `name=value`、带 `Cookie:` 前缀整行、
  以及整段请求头（自动抽取 `Cookie` 行）；**不裁剪字段**（会话可能依赖多个 cookie 组合）。
- 必需头：`Cookie`、`Origin`、`Referer: {origin}/account/usage`、`X-Requested-With: XMLHttpRequest`、`Bx-V: 2.5.35`。

### 7.2 计算

- 汇总块 `total_quota.quota_summary`（也兼容 camelCase `totalQuota.quotaSummary`）→ `base`：
  `used=used_value`、`total=limit_value`、`remaining=remaining_value`（缺省 `total−used`）、
  `provided=usage_percentage`、`unit`。
- 若存在 `shared_quota`：`used/total/remaining` 分别为 `base + shared` 对应项之和。
- `usedPercent`：
  - 有共享包时**按合并后重算** `used/total×100`（不信任接口给出的比例）；
  - 无共享包时优先用接口 `usage_percentage`，否则 `used/total×100`；
  - 最终 clamp 到 `0..100`，`remainingPercent = 100 − usedPercent`。
- `resetsAt`（`nextResetAt`，双单位兼容）：数值 `>1e10` 视为毫秒，否则视为秒 ×1000。
  平台偶发返回已过期时间，前端仅在**晚于当前时刻**时才展示。
- `packExpiry`（`resourcePackageQuota.quota_detail[]`）：`remaining_value>0` 且 `expires_at`（毫秒）>0
  的包，输出 `{until, remain}`。

### 7.3 前端（`renderQoder`）

- `大模型 Credits`：`剩余 {remainingPercent}%` + 进度条 + `已用 {used} / {total} {unit}`。
- 汇总行：`剩余 {remaining} {unit}`（有共享包时标“含共享资源包”；`resetsAt` 未过期才显示“重置于”）+ 到期提示。

## 8. MiniMax 余额

### 8.1 获取（`collectMinimax`）

- 接口：`GET {region}/account/query_balance`，请求头 `Authorization: Bearer <API Key>`。
  - `region=cn`（默认）→ `https://api.minimaxi.com`，币种 CNY；
    `region=intl` → `https://api.minimax.io`，币种 USD。
  - `config/minimax.json` 的 `baseUrl` 可覆盖接口根地址。
- **与其它数据源不同**：这是**官方公开接口**，只需按量付费 API Key，不依赖网页登录态，
  不会随网页改版或登录态过期失效。
- **仅覆盖按量付费账号**：Token Plan 订阅 Key（非 `sk-api-` 前缀）走
  `/v1/token_plan/remains`（另一套 `model_remains` 双窗口结构），本模块暂未实现。
- 失败判定：先看 `base_resp.status_code`（非 0 即失败，鉴权/参数错误可能带回 HTTP 400 或 200），
  再看 HTTP 状态；超时/网络错误统一返回 `ok:false`。

### 8.2 关键字段

| 原始字段 | 含义 | 卡片展示 |
| --- | --- | --- |
| `available_amount` | 可用余额（= 现金 + 代金券） | 主数值 |
| `cash_balance` | 现金余额（可为负） | 明细行 |
| `voucher_balance` | 代金券余额 | 明细行 |
| `credit_balance` | 赠送积分余额 | 明细行 |
| `owed_amount` | 欠费金额 | 不在卡片展示 |

金额均为**字符串**（如 `"23.02"`）；非法值置 `null`，前端显示 `—`。

> `todaySpent` / `todaySpentEstimated` **不是上游字段**，由 `server.js` 的 `withMinimaxDaily()` 计算：
> MiniMax 按量付费**没有消费明细接口**，故按「同一自然日内可用余额的**下滑量**累加」近似——
> 余额下降计入消费、余额上升（充值）不计入、跨天重置；当日快照存 `data/minimax-state.json`。
> 由于只在服务运行时采样，停机期间的消费会在下次采集时按余额差**一次性**计入。

### 8.3 前端（`renderMinimax`）

- 标题不带徽标（国内/国际版口径由 `region` 决定，无需在卡片上重复标注）。
- 主数值 `可用余额 {金额}`；次行 `今日消费 {金额}（估算）`；明细行 `现金 … · 代金券 … · 积分 …`（有值才显示，不含欠费）。

## 9. 服务端聚合与自适应刷新（`server.js`）

- **配置加载**：`service/codex/deepseek/workbuddy/trae/mimo/qoder/minimax` 各读一个文件，缺文件即空对象。
- **数据源表**：`SOURCE_COLLECTORS` 把每个 source 映射到采集函数；DeepSeek 一次采集同时产出
  `deepseek` 与 `deepseekUsage` 两个字段。
- **自适应刷新**（每源独立计时/退避）：
  - 基准间隔 `baseSeconds`（默认 60s）、上限 `maxSeconds`（默认 7200s）、倍数 `factor`（默认 2）；
  - 每次采集后对响应片段做**递归按键排序序列化**（`stableStringify`）得到指纹，与上次比对：
    **有变化或手动刷新 → 回到基准间隔；连续无变化 → 间隔 ×factor 直至上限**；
  - 间隔加 ±10% 抖动，各源首次启动按 2s 错峰，避免同时打上游。
- **接口 `/api/usage`**：
  - 默认：只补齐从未采集过的源，其余返回各自最新缓存；
  - `?source=<name>`：手动强制采集该源一次并复位其间隔（前端点卡片走这条）；
  - `?refresh`：强制采集全部源（调试用）。
- **聚合输出**（`assembleUsage`）：各源最新片段 + `updatedAt`（整体）+ 每源 `<source>UpdatedAt`（前端用于显示“最近采集”）。

## 10. 前端通用展示计算（`index.html`）

- **轮询**：页面每 60s `GET /api/usage`；时钟每 15s 本地刷新（仅显示时:分，DOM 无变化时不写入，降低平板常亮功耗）；点击卡片 = 对单源手动刷新。
- **颜色阈值**（`barColor`）：剩余百分比 `≤10` 红、`≤25` 黄、其余绿。
- **数字格式化**：`fmtInt` 千分位；`fmtTokens` 按 K/M 缩写；`fmtMoney` 固定 4 位小数；
  `fmtCredit` 保留 2 位小数并千分位；币种 `USD→$`，其余 `¥`。
- **到期积分提示**（`expirySummary`，WorkBuddy/TRAE/Qoder 共用）：
  1. 未来 3 天到期积分 >0 → `未来3天到期积分 {sum}`；
  2. 否则未来 7 天 >0 → `未来7天到期积分 {sum}`；
  3. 否则若有未到期积分 → `最近到期 {最近日期} 积分 {当日到期合计}`；
  4. 都无 → `近期无积分到期`。

## 11. 已知限制与注意项

- **DeepSeek 类型未全覆盖**：用量明细当前仅映射 4 种 `type`（见 §3.2），`PROMPT_TOKEN` 等其它类型不计入。
- **WorkBuddy 当日消耗为估算**：平台无日期粒度用量，用“当日首读基线差值”近似，跨天/换包会重置基线。
- **内部接口易失效**：DeepSeek 用量、WorkBuddy、TRAE、MiMo、Qoder 均依赖**非公开内部接口 + 登录态**，
  平台改版或令牌过期后会失败，需重新获取凭据（见凭据手册）。
- **MiniMax 走官方公开接口**：只覆盖按量付费账号且只有**账户余额**，无按日/按模型用量明细；
  卡片上的「今日消费」为**估算值**（余额下滑累加，见 §8.2）。Token Plan 订阅口径
  （`/v1/token_plan/remains`）尚未接入。
- **令牌策略差异**：TRAE 明确**不自动续期**（避免轮换令牌族踢掉其它客户端）；WorkBuddy 仅在显式配置
  `refreshUrl` 时才续期。
- **Codex 付费双窗口**：采集端已按 `windowDurationMins` 通用处理，但 `primary(5h)+secondary(周)` 的组合
  尚未在付费账号环境实测确认。
- **MiMo 套餐周期结束时间**接口已返回但前端暂未展示。