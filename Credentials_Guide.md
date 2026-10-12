# 凭据获取说明

本文件记录 M5 AI 用量看板各数据源的凭据获取方式。看板的凭据都只保存在服务端
`dashboard/config/` 目录下（已加入 `.gitignore`），不会下发到前端。

> 说明：本文件按产品分节，已覆盖 Xiaomi MiMo、WorkBuddy CN、TRAE CN、Qoder CN、DeepSeek、
> MiniMax 与 Codex。其中 Codex 不使用可复制的 API Key，而是复用 ChatGPT OAuth 登录态（`~/.codex/auth.json`）；MiniMax 使用官方公开接口，只需按量付费 API Key。获取方式见对应章节。
> 各数据源“拿到凭据之后如何取数、如何计算”见
> [Dashboard_Data_Modules.md](file:///e:/AIProjects/HUAWEI_M5/Dashboard_Data_Modules.md)。

---

## Xiaomi MiMo（Cookie）

### 接入方式

MiMo 官方只公开推理 API，不公开账户级用量/余额接口。因此看板通过平台网页控制台的
内部接口读取「Token Plan 月度额度」与「账户余额」，鉴权使用**网页登录态 Cookie**。
该 Cookie 属非公开鉴权凭据，会过期，过期后需按下方步骤重新获取。

### 需要的 Cookie 字段

| 字段 | 是否必需 | 说明 |
| --- | --- | --- |
| `api-platform_serviceToken` | 必需 | 平台登录态令牌 |
| `userId` | 必需 | 小米账号 ID |
| `api-platform_ph` | 可选 | 存在则一并保留 |
| `api-platform_slh` | 可选 | 存在则一并保留 |

复制整串 Cookie 即可，代码会自动只保留上述字段、丢弃其余无关项；缺少两个必需字段时
看板会明确提示。

### 获取步骤

1. 用小米账号登录 [Xiaomi MiMo 开放平台](https://platform.xiaomimimo.com/)。
2. 按 `F12` 打开开发者工具，切到 **Network（网络）** 面板。
3. 刷新控制台页面（或进入「余额」页面）。
4. 在请求列表中找到 `https://platform.xiaomimimo.com/api/v1/balance` 请求并点开。
5. 在 **Request Headers（请求标头）** 里找到 `Cookie` 一行，复制其完整值。

### 写入配置

将复制到的整串 Cookie 填入 `dashboard/config/mimo.json` 的 `cookie` 字段
（该文件不存在时可直接复制 `dashboard/config/mimo.example.json` 重命名）：

```json
{
  "cookie": "api-platform_serviceToken=\"...\"; userId=\"1234567\"; api-platform_ph=\"...\""
}
```

注意事项：

- **必须写成一行**，不能包含换行；代码会拒绝含换行的 Cookie。
- Cookie 值里的双引号需在 JSON 中转义为 `\"`（见上面示例），外层 JSON 的引号不动。
- 其余无关 Cookie 字段可以不删，代码会自动过滤。

### 生效与过期

- 配置只在服务启动时读取一次，**修改 `mimo.json` 后需重启看板服务**才会生效。
- Cookie 过期后，卡片会提示 `usage HTTP 401（Cookie 无效或已过期）`；
  按上面的步骤重新复制 Cookie、覆盖 `mimo.json` 并重启服务即可。

### 对应接口（只读）

| 用途 | 接口 |
| --- | --- |
| 按天用量明细（今日请求次数 / Tokens / 缓存命中） | `GET /api/v1/usage/detail?year=&month=` |
| 按天消费金额明细（今日消费） | `POST /api/v1/usage/detail/list?api-platform_ph=` |
| Token Plan 月度额度 | `GET /api/v1/tokenPlan/usage` |
| 套餐信息 | `GET /api/v1/tokenPlan/detail` |
| 账户余额 | `GET /api/v1/balance` |

（基础地址：`https://platform.xiaomimimo.com`。仅 Token Plan 订阅账号有月度额度；
按量付费账号无月度额度，看板会只展示余额。）

`usage/detail` 返回当月按天数组：`tokenUsage` 每行为
`[日期, 输入, 输出, 总计, 缓存命中]`，`requests` 每行为 `[日期, 请求次数]`。

`usage/detail/list` 请求体为 `{"year":<年>,"month":<月>}`，返回当月按天按模型的计费明细，
每行含 `date`（`YYYY-MM-DD`）、`model`、`currency`、`consumedAmount`（字符串金额）等；
看板把当天各行 `consumedAmount` 求和即为「今日消费」。

> **注意**：该接口是 POST，但平台要求把 `api-platform_ph`（Cookie 中该字段的值**去掉双引号**）
> 作为 **query 参数** 发送（`?api-platform_ph=...`），只放请求头或请求体都会返回 401。
> 因此 `api-platform_ph` 虽是可选字段，但缺了它就无法采集消费金额，卡片会显示「今日消费 —」。

> **金额语义**：金额只统计**按量计费**部分，套餐额度内的调用不计费、也不会出现在该列表中，
> 所以订阅账号在额度内的日子「今日消费」为 ¥0，属正常现象；看板不展示卡在额度内时的消费。

---

## WorkBuddy CN（accessToken）

### 接入方式

WorkBuddy CN（腾讯 CodeBuddy 国内版）按积分（Credits）计费。官方不开放账户级用量接口，
看板通过平台内部接口读取「积分包余额」，鉴权使用**登录态 accessToken**，请求头为
`Authorization: Bearer <accessToken>` + `X-User-Id: <uid>`。该令牌等同账号凭据、会过期，
且本地登录态以**字段级加密**存储，不能直接复制，需先解密后填入配置。

### 需要的字段

| 字段 | 是否必需 | 说明 |
| --- | --- | --- |
| `accessToken` | 必需 | 登录态访问令牌（JWT 形态，`eyJ...` 开头） |
| `uid` | 必需 | 账号 ID，取自登录态 `account.uid`，作为 `X-User-Id` 发送 |
| `domain` | 必需 | 服务域名，取自登录态 `auth.domain`（国内实测 `www.workbuddy.cn`） |
| `refreshToken` | 可选 | 刷新令牌；仅当同时配置 `refreshUrl` 时才用于自动续期 |
| `refreshUrl` | 可选 | 令牌续期端点；平台未公开，留空即不自动续期（**推荐留空**） |

### 登录态文件位置

桌面端把登录态写在明文 JSON 文件里：

- Windows：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`
- macOS：`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`
- Linux：`~/.config/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`

**注意**：v5.x 起客户端的 `accessToken` / `refreshToken` 是字段级加密字段，形如
`{"$wbEncrypted":1,"envelope":"<base64 JSON>"}`，直接复制无效，必须先解密。

### 获取步骤（推荐：复用本机签到技能解密）

本机 `WorkBuddy签到助手` 技能自带解密脚本，能借 WorkBuddy 客户端本体自动取得加密密钥，
客户端升级轮换密钥时也无需改脚本：

1. 确认已安装并登录 WorkBuddy 桌面端。
2. 运行：

   ```powershell
   node "C:\Users\<用户名>\.workbuddy\skills\workbuddy-checkin\scripts\decrypt-token.js"
   ```

3. 从输出中取以下三行（其余为 stderr 安全提示，不进入 stdout）：

   ```
   DECRYPT_RESULT:<accessToken>
   ACCOUNT_UID:<uid>
   AUTH_DOMAIN:<auth.domain>
   ```

> Windows 上检测到字段级加密时，脚本会自动改用客户端以 Node 模式
> （`ELECTRON_RUN_AS_NODE=1`）解密。若提示找不到客户端，可用环境变量
> `WB_CHECKIN_APP_EXE` 指定 `WorkBuddy.exe` 的完整路径。

### 备选：手工解密（了解原理用）

`envelope` 是 AES-256-GCM 信封，解密流程：

1. `key = SHA256(atRestSecretKey 字符串, utf8)` → 32 字节；`keyId = SHA256(key).hex[:16]`
   （第二层 SHA256 作用于**原始字节**，不是十六进制字符串）。
2. 将 `envelope` 按 base64 解码，得到
   `{"suite":1,"keyId":...,"nonce":...,"authTag":...,"ciphertext":...}`，先校验 `keyId`
   与登录态信封一致。
3. 用 `aes-256-gcm` 解密，AAD 对齐客户端 `buildAuthenticatedContextAad(keyId, 1, "field")`：

   ```
   "WB-AAD\0" | [1] | lenPrefix("WBEV1") | lenPrefix("sym-v1") | uint32BE(suite)
             | lenPrefix(keyId) | [2] | [0] | [0]
   ```

   其中 `lenPrefix(s) = uint32BE(len) + s 的 UTF-8 字节`。

`atRestSecretKey` 由客户端构建期注入、随版本轮换，只经原生绑定
`electron_browser_workbuddy_storage.loggerGet()` 暴露，纯 Node 取不到——这正是推荐上面
「借客户端解密」方式的原因。

### 写入配置

将解出的值填入 `dashboard/config/workbuddy.json`（文件不存在时复制
`dashboard/config/workbuddy.example.json` 重命名）：

```json
{
  "accessToken": "eyJ...",
  "refreshToken": "eyJ...",
  "uid": "644aabec-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "domain": "www.workbuddy.cn",
  "refreshUrl": ""
}
```

注意：`accessToken` 与 `uid` 必须成对配置；`refreshUrl` 留空即关闭自动续期（推荐）。

### 生效与过期

- 配置只在服务启动时读取一次，**修改 `workbuddy.json` 后需重启看板服务**才会生效。
- `accessToken` 过期后卡片会提示鉴权失败（HTTP 401/403），按上方步骤重新导出并覆盖即可。
- 默认不自动续期；即使配置了 `refreshToken`，也需同时给出 `refreshUrl` 才会尝试续期。

### 对应接口（只读）

| 用途 | 接口 |
| --- | --- |
| 积分包余额 | `POST /v2/billing/meter/get-user-resource`（回退 `POST /billing/meter/get-user-resource-summary`） |

基础地址：`https://www.workbuddy.cn`。请求头 `Authorization: Bearer <accessToken>` +
`X-User-Id: <uid>`，请求体 `{}`。平台鉴权失败时仍可能返回 HTTP 200，错误信息在响应体的
`code` 字段中，看板已做兼容判断。

---

## TRAE CN（Cloud-IDE-JWT）

### 接入方式

TRAE CN（字节跳动 AI IDE 国内版）按积分（Credits）计量。官方不开放账户级额度接口，
看板通过 IDE 内部接口读取「积分额度」，鉴权使用**登录态令牌 Cloud-IDE-JWT**，请求头为
`Authorization: Cloud-IDE-JWT <token>`。该令牌等同账号凭据、会过期，且本地登录态以
**tc 加密容器（AES-128-CBC）**存储，不能直接复制，需先解密后填入配置。

### 需要的字段

| 字段 | 是否必需 | 说明 |
| --- | --- | --- |
| `cloudIdeJwt` | 必需 | 登录态令牌（JWT 形态，`eyJ...` 开头），即解密后的 `token` |
| `deviceId` | 可选 | 设备 ID，取自 storage.json 中 `iCubeAuthInfo://icube-dc:<id>` 的键名 |
| `machineId` | 可选 | 机器码，取自 storage.json 的 `telemetry.machineId` |

设备头非必需，但部分内部接口会校验；提取脚本会把后两项一并给出，填入即可。

### 登录态文件位置

桌面端把登录态写在 `storage.json`（字段 `iCubeAuthInfo://icube.cloudide`，**加密**）：

- Windows（经典版）：`%APPDATA%\Trae CN\User\globalStorage\storage.json`
- Windows（SOLO 版）：`%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json`
- macOS：`~/Library/Application Support/Trae CN/User/globalStorage/storage.json`（未实测）
- Linux：`~/.config/Trae CN/User/globalStorage/storage.json`（未实测）

### 获取步骤（推荐：用仓库自带提取脚本）

`dashboard/trae-token.js` 会自动探测上述目录、解密登录态并打印可直接粘贴的 JSON：

1. 确认已安装并登录 TRAE 桌面端（Trae CN 经典版或 TRAE SOLO CN）。
2. 运行（在 `dashboard/` 目录下）：

   ```powershell
   node trae-token.js
   ```

   若自动探测不到，可显式指定数据目录（目录名或绝对路径）：

   ```powershell
   node trae-token.js --dir "Trae CN"
   ```

3. 脚本会输出「来源」「账号」「令牌有效期至」，以及一段 JSON，直接复制其内容即可。
   提取脚本仅在此时运行一次，看板服务本身不读取本机文件。

### 加密原理（了解用）

`iCubeAuthInfo://icube.cloudide` 的值为 tc 容器密文，解密流程：

1. base64 解码后，前 6 字节为头部，用于识别加密类型：`746305100000` → `AES`，
   `123920200203` → `AES_PRIVATE`。
2. 跳过 6 字节头部与随后 32 字节随机数；随机数经 `SHA512` 后与一组固定盐值（按类型
   选取，两组盐各自 XOR）拼接，再 `SHA512`，其前 16 字节为 AES 密钥、后 16 字节为 IV。
3. `aes-128-cbc` 解密后，前 64 字节为 `SHA512(明文)` 校验值，其后才是明文 JSON。

盐值随客户端版本可能轮换，脚本若提示「哈希校验失败」，多因客户端升级导致。

### 写入配置

将脚本输出填入 `dashboard/config/trae.json`（文件不存在时复制
`dashboard/config/trae.example.json` 重命名）：

```json
{
  "cloudIdeJwt": "eyJ...",
  "deviceId": "3225318521581xxx",
  "machineId": "cf16...f8a"
}
```

### 生效与过期

- 配置只在服务启动时读取一次，**修改 `trae.json` 后需重启看板服务**才会生效。
- `cloudIdeJwt` 会过期（实测有效期约两周，脚本输出里会显示「令牌有效期至」）；过期后
  卡片提示令牌无效/过期，重跑提取脚本、覆盖 `trae.json` 并重启服务即可。
- **刻意不做自动续期**：TRAE 的 `ExchangeToken` 会轮换整个令牌族，会把同一账号在其它
  客户端的登录态一起踢下线，故看板只做只读、被动使用令牌。
- `cloudIdeJwt` 等同账号登录态，**勿外泄、勿提交**（`config/*.json` 已在 `.gitignore` 内）。

### 对应接口（只读）

| 用途 | 接口 |
| --- | --- |
| 积分额度 | `POST /trae/api/v2/pay/ide_user_ent_usage` |

基础地址：`https://api.trae.cn`。请求头 `Authorization: Cloud-IDE-JWT <token>`，请求体
`{"require_usage": true, "req_source": 0}`。响应为**扁平结构**（无 `code`/`data` 包裹），
聚合用量在 `usage_summary`（`total_amount` 总额、`consumed_amount` 已用、
`consumption_ratio` 已用比例），权益包明细在 `user_entitlement_pack_list`（每包的
`usage.credits_amount` 是该包**已消耗**量，非额度）。

---

## Qoder CN（Cookie）

### 接入方式

Qoder CN（`qoder.com.cn` 全功能版）按大模型 Credits 计量。官方 OpenAPI 只面向 Teams/企业版
（需组织 API Key），**个人账号不适用**；个人用量只能读网页控制台的内部接口，鉴权使用
**网页登录态 Cookie**。该 Cookie 等同账号登录态、会过期，过期后需重新从浏览器复制。

> 两条产品线账号独立：Qoder CN（原通义灵码，阿里云账号）与 Qoder CN 全功能版
> （`qoder.com.cn` 账号）。本项目使用**全功能版**；国际版为 `qoder.com`，接口路径相同、
> 域名不同，按 `site` 配置区分。

### 需要的字段

| 字段 | 是否必需 | 说明 |
| --- | --- | --- |
| `cookie` | 必需 | 浏览器登录 `qoder.com.cn` 后的会话 Cookie |
| `site` | 可选 | `cn`（默认，`qoder.com.cn`）或 `intl`（`qoder.com`） |

Cookie 整形较宽松，以下三种都可直接粘贴，代码会自动归一：

- 纯值：`name1=value1; name2=value2`
- 单行带头：`Cookie: name1=value1; name2=value2`
- 整段请求头：从浏览器复制的多行内容（自动抽取其中的 `Cookie` 行）

### 获取步骤

1. 用 Qoder CN 账号登录 [qoder.com.cn](https://qoder.com.cn)。
2. 按 `F12` 打开开发者工具，切到 **Network（网络）** 面板。
3. 进入「账户用量」页面（`https://qoder.com.cn/account/usage`）并刷新。
4. 在请求列表中找到 `https://qoder.com.cn/api/v2/me/usages/big_model_credits` 请求并点开。
5. 在 **Request Headers（请求标头）** 里找到 `Cookie` 一行，复制其完整值（或整行）。

### 写入配置

将复制到的值填入 `dashboard/config/qoder.json`（文件不存在时复制
`dashboard/config/qoder.example.json` 重命名）：

```json
{
  "cookie": "name1=value1; name2=value2",
  "site": "cn"
}
```

注意：Cookie 值里的双引号需在 JSON 中转义为 `\"`；`site` 用国际版时才改为 `intl`。

### 生效与过期

- 配置只在服务启动时读取一次，**修改 `qoder.json` 后需重启看板服务**才会生效。
- Cookie 过期后，卡片会提示 `采集失败：HTTP 401（Qoder 登录态无效或已过期…）`；
  按上面的步骤重新复制 Cookie、覆盖 `qoder.json` 并重启服务即可。
- Cookie 等同账号登录态，**勿外泄、勿提交**（`config/*.json` 已在 `.gitignore` 内）。

### 对应接口（只读）

| 用途 | 接口 |
| --- | --- |
| 大模型 Credits 用量 | `GET https://qoder.com.cn/api/v2/me/usages/big_model_credits`（国际版 `https://qoder.com` 同路径） |

必需请求头：`Cookie`、`Origin: https://qoder.com.cn`、`Referer: https://qoder.com.cn/account/usage`、
`X-Requested-With: XMLHttpRequest`、`Bx-V: 2.5.35`。响应顶层按泳道分为 `plan_quota` /
`resource_package_quota` / `total_quota` 等，聚合值在 `total_quota.quota_summary`
（`used_value` / `limit_value` / `remaining_value` / `usage_percentage` / `unit`，CN 版为 snake_case）；
时间字段 `nextResetAt` 为毫秒时间戳。字段语义与计算详见
[Dashboard_Data_Modules.md](file:///e:/AIProjects/HUAWEI_M5/Dashboard_Data_Modules.md) 第 7 节。

---

## DeepSeek（API Key + 网页登录态）

### 接入方式

DeepSeek 分两条**互相独立**的链路，缺哪一个，对应部分就显示「未配置」：

- **余额**：官方开放 API 提供账户余额，鉴权用**开放平台 API Key**（`sk-` 开头）。
- **消费金额 / API 请求次数 / Tokens（按天）**：官方不提供账户级用量接口，只能通过
  **平台网页控制台的内部接口**获取，鉴权用**网页登录态 `userToken`**（JWT 形态）。
  该 `userToken` 属非公开会话凭据、会过期，过期后需按下方步骤重新获取。

### 需要的字段

| 字段 | 是否必需 | 说明 |
| --- | --- | --- |
| `deepseekApiKey` | 余额必需 | 开放平台 API Key，`sk-` 开头 |
| `deepseekPlatformToken` | 用量必需 | 平台网页登录态令牌（`eyJ` 开头），取自浏览器 `localStorage.userToken` 的 `value` |

### 获取步骤

**A. `deepseekApiKey`（余额用，官方 API Key）**

1. 登录 [DeepSeek 开放平台](https://platform.deepseek.com/)，进入左侧 **API keys** 页。
2. 点「创建 API key」，复制生成的 `sk-` 开头密钥（**仅创建时显示一次**，请立即保存）。

**B. `deepseekPlatformToken`（用量用，网页登录态）**

1. 用同一账号登录 [platform.deepseek.com](https://platform.deepseek.com)。
2. 在该站点页面按 `F12` 打开开发者工具，切到 **Console（控制台）**。
3. 执行：

   ```js
   JSON.parse(localStorage.getItem('userToken')).value
   ```

4. 控制台打印出一长串 `eyJ` 开头的令牌，复制整串即为 `deepseekPlatformToken`。

> 备用路径：开发者工具 → **Application（应用）** → **Local Storage** →
> `https://platform.deepseek.com` → 找到 `userToken`，取其 `value` 字段的值
> （`userToken` 本身是 JSON 字符串，真正的令牌在 `.value` 里）。

### 写入配置

将两个值填入 `dashboard/config/deepseek.json`（文件不存在时复制
`dashboard/config/deepseek.example.json` 重命名）：

```json
{
  "deepseekApiKey": "sk-...",
  "deepseekPlatformToken": "eyJ..."
}
```

### 生效与过期

- 配置只在服务启动时读取一次，**修改 `deepseek.json` 后需重启看板服务**才会生效。
- `deepseekApiKey` 用于官方余额接口，长期有效。
- `deepseekPlatformToken` 是网页登录态、**会过期**；过期后卡片提示
  「用量 Token 无效或已过期，请重新获取」，按上方 B 步骤重新获取、覆盖
  `deepseek.json` 并重启服务即可。
- 两个值都等同账号凭据，**勿外泄、勿提交**（`config/*.json` 已在 `.gitignore` 内）。

### 对应接口（只读）

| 用途 | 接口 |
| --- | --- |
| 账户余额（官方 API） | `GET https://api.deepseek.com/user/balance` |
| 用量金额 / 请求次数 / tokens | `GET /api/v0/usage/amount?month=&year=` |
| 用量费用 | `GET /api/v0/usage/cost?month=&year=` |

用量接口基础地址为 `https://platform.deepseek.com`，请求头
`Authorization: Bearer <deepseekPlatformToken>` + `x-client-platform: web`。响应外层为
`{ code, data: { biz_code, biz_data } }`，**鉴权失败时仍返回 HTTP 200**，错误在 `code`
（如 `40003 Authorization Failed`）；看板已做兼容判断，避免把过期令牌误判为「今日零用量」。

---

## Codex（ChatGPT OAuth 登录态）

### 接入方式

Codex 额度**不是**用可复制的 API Key 获取的，而是**复用 ChatGPT 订阅的 OAuth 登录态**：
看板读取登录态里的 `access_token`，直接向 ChatGPT 用量接口
`GET https://chatgpt.com/backend-api/wham/usage` 查询套餐与额度窗口。

**`config/codex.json` 的来源就是 `~/.codex/auth.json`**：把该文件的**完整内容**复制过来即可
（Windows 默认 `C:\Users\<你>\.codex\auth.json`，由 `codex login` 生成）。看板只做只读读取，
**不外发令牌、不写回、不调用 OAuth 续期**——Codex 的 `refresh_token` 是一次性轮换的，
外部续期会踢掉其它客户端的登录态。

> 与早期版本的区别：旧版通过子进程跑 `codex app-server` 取额度，要求部署节点安装 codex CLI；
> 现在改为纯 HTTP，**节点无需安装 codex 二进制**，更适合容器 / Ubuntu 环境。

### 需要的字段

`config/codex.json` 的内容即 `~/.codex/auth.json` 原文，看板只用到其中两个字段：

| 字段 | 是否必需 | 说明 |
| --- | --- | --- |
| `tokens.access_token` | 是 | 作为 `Authorization: Bearer <token>` 调用用量接口 |
| `tokens.account_id` | 是 | 作为 `ChatGPT-Account-Id` 请求头，避免选错账号 |
| `tokens.refresh_token` / `tokens.id_token` / `last_refresh` | 否 | 看板不读取，按原样保留即可 |

### 前置条件

| 条件 | 说明 |
| --- | --- |
| 已在某处登录过 Codex | 在**任意一台**能登录的机器上执行过 `codex login`，得到 `~/.codex/auth.json` |
| 已复制登录态 | 把 `~/.codex/auth.json` 的完整内容复制到 `dashboard/config/codex.json` |

> 部署节点本身**不需要**安装 Codex CLI，只需要这份登录态文件。

### 获取步骤

1. 在任意一台机器安装 Codex CLI（若尚未安装）：

   ```powershell
   npm i -g @openai/codex
   ```

2. 登录（浏览器 OAuth），登录成功后生成登录态：

   ```powershell
   codex login
   ```

   默认路径 `C:\Users\<你>\.codex\auth.json`（Linux/macOS 为 `~/.codex/auth.json`）。

3. 把该文件的**完整内容**复制到 `dashboard/config/codex.json`（覆盖 `{}` 占位）：

   ```powershell
   Copy-Item $env:USERPROFILE\.codex\auth.json .\config\codex.json -Force
   ```

### 写入配置

`dashboard/config/codex.json` —— 内容与 `~/.codex/auth.json` 完全一致（下例为结构示意）：

```json
{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "...",
    "access_token": "...",
    "refresh_token": "...",
    "account_id": "..."
  },
  "last_refresh": "..."
}
```

该文件已加入 `.gitignore`（`config/*.json`），**不要提交进仓库**。

### 生效与过期

- 配置只在服务启动时读取一次，**修改 `codex.json` 后需重启看板服务**才会生效。
- `tokens.access_token` 是 JWT，存在有效期。看板会在本地解析其 `exp` 声明，过期时卡片提示
  「Codex 登录态已过期」；此时重新登录并覆盖 `config/codex.json` 即可。
- 看板**不会自动续期**（原因见上）。长期部署需按令牌有效期定期更新该文件。

### 注意事项

- 用量接口 `chatgpt.com/backend-api/wham/usage` 是**未公开内部接口**，上游改动可能导致
  卡片报错；届时按上面步骤补齐/更新凭据，或留意接口变更。
- 免费账号只返回单个窗口（实测为 30 天「每月窗口」）；付费账号返回 5 小时 + 每周两个窗口。
  代码按接口返回的窗口时长自适应，无需区分账号类型。

### 对应接口（只读）

| 用途 | 方式 |
| --- | --- |
| 套餐与额度窗口 | `GET https://chatgpt.com/backend-api/wham/usage`，头 `Authorization: Bearer <tokens.access_token>` + `ChatGPT-Account-Id: <tokens.account_id>` |

返回 `rate_limit.primary_window` / `secondary_window`，各含 `used_percent`（已用百分比）、
`limit_window_seconds`、`reset_at`（重置时间，**秒**级时间戳）。`limit_window_seconds`
会映射为「5 小时窗口 / 每日窗口 / 每周窗口 / 每月窗口」。

---

## MiniMax（按量付费 API Key）

### 接入方式

走 **MiniMax 开放平台官方公开接口**，只需按量付费 API Key（Bearer 鉴权），**不需要网页登录态 Cookie**，
也不像其它数据源那样会因网页改版或登录态过期而失效。

> ⚠️ Token Plan 订阅的「订阅 Key」与按量付费 API Key **不能混用**，对应不同接口。本看板当前只接入
> **按量付费**口径（`/account/query_balance`）；Token Plan 口径见文末说明。

### 需要的字段

| 字段 | 说明 |
| --- | --- |
| `apiKey` | 开放平台按量付费 API Key，形如 `sk-api-...` |
| `region` | `cn`（国内平台，默认）或 `intl`（国际平台） |

### 获取步骤

1. 登录开放平台控制台：国内 [platform.minimaxi.com](https://platform.minimaxi.com) / 国际 [platform.minimax.io](https://platform.minimax.io)。
2. 进入「账户管理 → API 密钥」（按量付费账号）新建或复制 API Key。
3. 记下所属平台（国内 / 国际），对应配置里的 `region`。

### 写入配置

`dashboard/config/minimax.json`：

```json
{
  "apiKey": "sk-api-********",
  "region": "cn"
}
```

> 可选：`baseUrl` 可覆盖接口根地址（默认按 `region` 取 `https://api.minimaxi.com` / `https://api.minimax.io`）。

### 生效与过期

- API Key **长期有效**，无固定过期时间；仅在控制台**删除/重置**该 Key 后才失效，届时替换即可。
- 修改配置后需重启服务才生效。

### 对应接口（只读）

| 用途 | 方式 |
| --- | --- |
| 账户余额 | `GET https://api.minimaxi.com/account/query_balance`（国际版 `https://api.minimax.io/...`），头 `Authorization: Bearer <apiKey>` |

返回金额均为**字符串**：`available_amount`（可用余额）、`cash_balance`（现金）、`voucher_balance`（代金券）、
`credit_balance`（积分）、`owed_amount`（欠费），错误信息在 `base_resp.status_code` / `status_msg`。

> Token Plan 订阅账号的用量为另一接口：`GET /v1/token_plan/remains`，返回 `model_remains[]`
> 的 5 小时滚动窗口 + 每周窗口（`current_interval_*` / `current_weekly_*`）；如需展示套餐口径可另行扩展。