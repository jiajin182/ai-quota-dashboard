# M5 AI 用量看板：部署到 ub 节点方案

> **部署对象**：`ub 节点` = 通过 SSH 连接的 Ubuntu 服务器（Ubuntu 22.04 x86_64，
> 已安装 Docker 29.1.3 + Docker Compose v2.40.3）。
> **目标**：把 `dashboard/` 采集服务从 Windows 本机搬到 ub 节点长期运行，平板经局域网访问看板。
> **可选前提**：本方案假设节点已在受信局域网内、不对外暴露公网，且节点可保留现有 3 个运行中的容器。

---

## 0. TL;DR（首次部署最短路径）

在**节点**上以普通用户（已加入 docker 组）执行：

```bash
# 1) 拉取可用镜像源并本地打标签（绕过 Docker Hub 直连超时，且不影响现有容器）
docker pull docker.1ms.run/library/node:20-bookworm-slim
docker tag  docker.1ms.run/library/node:20-bookworm-slim node:20-bookworm-slim

# 2) 代码与配置就位（代码/配置从本机 scp 上传，见第 5 节）
cd /opt/m5-dashboard

# 3) 构建 + 启动
docker compose build
docker compose up -d

# 4) 验证
docker compose logs --tail=50 m5-dashboard
curl -s http://127.0.0.1:8787/api/usage
```

看不到 `[m5-dashboard] 已启动` 或 `/api/usage` 有数据即视为部署完成；平板把
`dashboardUrl` 改成 `http://<节点局域网IP>:8787/` 即可。

---

## 1. 部署目标与前提假设

| 项 | 内容 |
| --- | --- |
| 服务本体 | Node.js 20（镜像内已含），**无第三方 npm 运行依赖**，仅标准库 |
| 对外接口 | `GET /`（看板页）、`GET /api/usage`（聚合只读 JSON） |
| 默认监听 | `0.0.0.0:8787`（由 `config/service.json` 控制） |
| 数据源 | Codex、DeepSeek、WorkBuddy、TRAE、Xiaomi MiMo、Qoder、MiniMax，共 7 类 8 张卡 |
| 网络边界 | **仅受信局域网**，不暴露公网；凭据只存服务端 `config/`，不下发前端 |
| 展示端 | 华为 M5（HarmonyOS 2）WallMode，WebView 直连节点 IP |

> 本方案**不改动业务代码**（`server.js` / `collector.js` / `public/index.html` 均无需修改），
> 只做「容器化打包 + 运行环境适配 + 凭据迁移」。

---

## 2. 方案选型

| 维度 | 方案 A：Docker Compose（**推荐**） | 方案 B：裸机 systemd |
| --- | --- | --- |
| 现状 | Dockerfile / docker-compose.yml **已就绪** | 需新写 unit 文件 |
| Codex 凭据 | 只需把 `config/codex.json` 挂载进容器（内容取自 `~/.codex/auth.json`） | 同样只需 `config/codex.json`，**两边都无需安装 codex CLI** |
| 环境隔离 | 好，卸载清理干净 | 依赖节点全局 Node |
| 出网依赖 | 构建期需能访问 Docker Hub（已有绕过方案） | 需 Node ≥18 + npm 可达 |
| 时区/今日统计 | 镜像内置 `tzdata` + `TZ`，开箱即用 | 需自行装 `tzdata` |
| 开机自启 | `restart: unless-stopped` 已配 | 需写 systemd `enable` |
| 适用场景 | 长期运行、想保持节点整洁 | 节点不便装 Docker |

**结论**：本项目已产出 Docker 制品，**优先方案 A**；
方案 B 作为「节点 Docker 受限」时的等价备选（见第 6 节）。两种方案都只需 `config/codex.json`，无需安装 codex CLI。

---

## 3. 节点侧前置条件

### 3.1 系统与运行时

| 检查项 | 命令 | 期望 |
| --- | --- | --- |
| 架构 | `uname -m` | `x86_64`（镜像多架构可用，Codex CLI 在 arm64 需另行验证） |
| Docker | `docker version --format '{{.Server.Version}}'` | 已装（实测 29.1.3） |
| Compose | `docker compose version` | 已装（实测 v2.40.3） |
| 磁盘 | `df -h /opt` | 预留 ≥ 2 GB（镜像约 300–500 MB） |
| 时间同步 | `timedatectl` | NTP 已同步（「今日用量」「重置时间」都依赖时钟） |

### 3.2 网络可达性（三处关键出网）

部署后服务是否能出网，直接决定哪几张卡能用：

| 出网目标 | 用途 | 不通时的表现 |
| --- | --- | --- |
| `api.deepseek.com` / `platform.deepseek.com` | DeepSeek 余额 + 今日用量 | DeepSeek 卡报 HTTP 错误 |
| `platform.xiaomimimo.com` / `qoder.com.cn` / `api.trae.cn` / `www.workbuddy.cn` | 国内平台内部接口 | 对应卡报鉴权/HTTP 错误 |
| **`chatgpt.com`（ChatGPT 后端）** | Codex 用量接口读额度 | **Codex 卡报 HTTP 错误 / 超时** |

> ⚠️ **重要**：Codex 额度由看板直接请求 `chatgpt.com/backend-api/wham/usage`（凭据取自
> `config/codex.json`，内容源于 `~/.codex/auth.json`），**必须能连到 `chatgpt.com`**。
> 若 ub 节点无出海网络，Codex 卡会失败——但这**不影响其它卡片**（各数据源相互独立、单独容错）。
> 这种情况下要么给节点配代理（容器需能继承代理环境变量），要么接受 Codex 卡不可用。

### 3.3 Docker Hub 镜像不可达的处理（实测踩坑）

节点直连 `registry-1.docker.io` **超时**（构建会长时间卡住），两种处理方式：

**方式一（推荐，零影响）：从镜像代理预取基镜像并本地打标签**

```bash
docker pull docker.1ms.run/library/node:20-bookworm-slim
docker tag  docker.1ms.run/library/node:20-bookworm-slim node:20-bookworm-slim
```

之后 `docker compose build` 会直接命中本地 `node:20-bookworm-slim`，无需改 Dockerfile。
（镜像站前缀以站点文档为准，`docker.m.daocloud.io` 亦可作为备用。）

**方式二（长期方案）：配置 daemon 镜像加速器**

```bash
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "registry-mirrors": ["https://docker.1ms.run", "https://docker.m.daocloud.io"]
}
EOF
sudo systemctl daemon-reload && sudo systemctl restart docker
```

> ⚠️ `registry-mirrors` **不支持热重载**，必须重启 docker daemon。节点现有 3 个容器会被
> 一并重启，**建议低峰期执行**，或先确认它们可容忍重启。若不便重启，用方式一即可。

> 备注：镜像只需从 Docker Hub 拉取基础镜像与应用代码，**不再安装 codex CLI**，构建过程无需访问 `registry.npmjs.org`。

---

## 4. 凭据与配置迁移

### 4.1 配置清单与迁移矩阵

`server.js` 启动时**一次性**读取 `config/` 下的配置文件（其中 `codex.json` 是凭据文件，其余为配置）；
**改配置后必须重启服务**才生效。

| 配置文件 | 字段 | 是否与机器绑定 | 迁移方式 |
| --- | --- | --- | --- |
| `config/service.json` | `host` / `port` / `refresh` | 否 | 直接复制（可按需改端口/刷新节奏） |
| `config/codex.json` | `tokens.access_token`、`tokens.account_id` | **是（含 OAuth 登录态）** | 内容取自 `~/.codex/auth.json`，需单独迁移，见 4.2 |
| `config/deepseek.json` | `deepseekApiKey`、`deepseekPlatformToken` | 否 | 直接复制；**平台 Token 会过期** |
| `config/workbuddy.json` | `accessToken`、`uid`、`domain` | 否 | 直接复制；**accessToken 会过期** |
| `config/trae.json` | `cloudIdeJwt`、`deviceId`、`machineId` | 否 | 直接复制；**JWT 约两周过期** |
| `config/mimo.json` | `cookie` | 否 | 直接复制；**Cookie 会过期** |
| `config/qoder.json` | `cookie`、`site` | 否 | 直接复制；**Cookie 会过期** |
| `config/minimax.json` | `apiKey`、`region`、`baseUrl`(可选) | 否 | 直接复制；**官方公开接口，Key 长期有效** |

> 说明：除 Codex 外，其余数据源**只持有可复制的只读令牌**，服务本身不读取本机文件，
> 因此这些配置可原样从本机 `config/` 搬到节点，**无需重新获取**（直到各自令牌过期）。
> 各字段的获取方法见 [Credentials_Guide.md](file:///e:/AIProjects/HUAWEI_M5/Credentials_Guide.md)。

### 4.2 Codex 凭据的迁移（唯一含「机器绑定」登录态的项）

Codex 卡的凭据就是 `config/codex.json`，其内容**取自 `~/.codex/auth.json`**（ChatGPT OAuth 登录态），
看板读取其中的 `access_token` 直接调用量接口取额度。

1. 在已登录 Codex 的机器上取出登录态，把**完整内容**写入 `config/codex.json`：

   ```powershell
   # 在本机 PowerShell 执行
   Copy-Item $env:USERPROFILE\.codex\auth.json .\dashboard\config\codex.json -Force
   ```

   随后随 `config/` 一起上传/部署到节点（该文件已在 `.gitignore` 中，不会进仓库）。

2. **节点无需安装 Codex CLI**：额度查询是纯 HTTP，不再依赖 `codex app-server`，
   也不需要挂载 `~/.codex` 目录。

3. **不要在其他地方刷新同一账号的令牌**：`refresh_token` 是一次性轮换的，若其它客户端
   （本机 codex、其它看板实例）刷新了，会与这份互相失效。看板本身**不会**刷新，
   只会在 `access_token` 过期时提示。

> ⚠️ `access_token` 会过期（JWT，有 `exp`）。长期部署需在过期后重新登录并覆盖
> `config/codex.json`；没有自动续期是刻意设计，避免踢掉你其它客户端的登录态。

### 4.3 其余数据源配置

从本机 `dashboard/config/` 直接拷贝 `*.json` 到节点即可（这些文件已加入 `.gitignore`，
**不要提交进仓库**）。若某数据源暂无凭据，可只放该文件以外的配置，服务会如实提示「未配置」。

---

## 5. 方案 A：Docker Compose 部署（推荐）

### 5.1 传代码

```powershell
# 本机 PowerShell
scp -r e:\AIProjects\HUAWEI_M5\dashboard <user>@<节点IP>:/opt/
```

> `config/` 与 `data/` 被 `.dockerignore` / `.gitignore` 排除，**不会也不需要打进镜像**；
> 单独上传即可（下一步）。若节点无 scp 权限，也可用 `git clone`（注意不要把 `config/*.json` 提交）。

### 5.2 放 Codex 登录态

```bash
# 节点上，确认登录态到位（对应执行 docker compose 的用户的 HOME）
ls -l ~/.codex/auth.json
```

- 若以**普通用户**（docker 组）执行 `docker compose`，`${HOME}` = `/home/<user>`，
  登录态放 `/home/<user>/.codex/`。
- 若用 `sudo`，`${HOME}` = `/root`，则需放 `/root/.codex/`。

> **建议的两处小改动（可选，更省心）**：把 compose 里两处挂载改成与执行用户无关的形式，
> 并补上 `data/` 持久化（否则容器重建会丢失 WorkBuddy「当日消耗」基线快照）：

```yaml
volumes:
  - ./codex-home:/root/.codex      # 代替 ${HOME}/.codex，登录态放 /opt/m5-dashboard/codex-home/
  - ./config:/app/config:ro
  - ./data:/app/data               # 持久化 workbuddy-state.json（建议新增）
```

### 5.3 放配置

```powershell
# 本机 PowerShell：上传 7 个配置文件
scp e:\AIProjects\HUAWEI_M5\dashboard\config\*.json <user>@<节点IP>:/opt/m5-dashboard/config/
```

> 注意：`docker-compose.yml` 把 `config` 挂载为**只读**（`:ro`）。因此 WorkBuddy 的
> **自动续期写回不会生效**——这与文档中「`refreshUrl` 推荐留空、不做自动续期」的结论一致，
> 属预期行为，不是故障。

### 5.4 构建与启动

```bash
cd /opt/m5-dashboard

# 建议先预取基镜像（若未做第 3.3 节）
docker pull docker.1ms.run/library/node:20-bookworm-slim
docker tag  docker.1ms.run/library/node:20-bookworm-slim node:20-bookworm-slim

docker compose build          # 构建不依赖 auth.json，可先行验证
docker compose up -d
```

### 5.5 验证

```bash
docker compose logs --tail=50 m5-dashboard      # 期望看到「[m5-dashboard] 已启动: http://0.0.0.0:8787」
docker compose ps                               # 期望 STATUS = Up

curl -s http://127.0.0.1:8787/api/usage                                  # 本机自测
curl -s "http://127.0.0.1:8787/api/usage?refresh=1"                      # 强制刷新全部源
curl -s "http://127.0.0.1:8787/api/usage?source=codex"                   # 单源强制刷新（排障用）

# 从局域网另一台机器验证（确认端口对局域网开放）
curl -s http://<节点IP>:8787/api/usage
```

**逐卡验收建议**（对照 `?refresh=1` 返回里各源的 `ok` 字段）：

| 卡片 | 期望 | 常见失败原因 |
| --- | --- | --- |
| Codex | `ok: true`，含 `windows[]` | 无出海网络 / `auth.json` 未迁移 / 版本不对齐 |
| DeepSeek | 余额 + `today` | `platformToken` 过期 |
| WorkBuddy | `totalRemain` | `accessToken`/`uid` 过期或缺失 |
| TRAE | `totalRemain` | JWT 过期（约两周） |
| MiMo | `quota`/`balance`/`today` | Cookie 过期 |
| Qoder | `used`/`total` | Cookie 过期 |
| MiniMax | `balance.available` | API Key 被删除/重置，或 `region` 与账号平台不符 |

---

## 6. 方案 B：裸机 systemd 部署（备选）

适用于节点不便装 Docker 的场景（无需安装 codex CLI，只需把 `config/codex.json` 放好）。

```bash
# 1) 安装运行时（Node ≥18 + tzdata）
sudo apt-get update && sudo apt-get install -y curl tzdata
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2) 部署代码到 /opt/m5-dashboard（同 5.1 / 5.3 上传代码与 config）
#    确认 config/codex.json 已放入（内容取自 ~/.codex/auth.json）

# 3) 写入 systemd unit
sudo tee /etc/systemd/system/m5-dashboard.service >/dev/null <<'EOF'
[Unit]
Description=M5 AI Usage Dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<运行用户>
WorkingDirectory=/opt/m5-dashboard
Environment=TZ=Asia/Shanghai
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# 4) 启动
sudo systemctl daemon-reload
sudo systemctl enable --now m5-dashboard
systemctl status m5-dashboard --no-pager
journalctl -u m5-dashboard -n 50 --no-pager
```

> 裸机模式没有镜像里的 `tzdata` 兜底，**务必设置 `TZ=Asia/Shanghai`**，否则
> 「今日用量」会按节点默认时区错位统计。

---

## 7. 平板端对接

服务搬家后，**平板里的看板地址必须同步改到节点 IP**（原先是 Windows 的 `<看板服务器IP>`）：

- 在 WallMode 内配置 `dashboardUrl=http://<节点局域网IP>:8787/`（**必须纯 IP**）。
- ⚠️ **不要用 `.local`/mDNS 名称**：HarmonyOS 2 自带 WebView 解析 mDNS 会失败
  （`ERR_NAME_NOT_RESOLVED`），这是此前已实测确认的坑。
- 改完地址后，平板上强制刷新或重启 WallMode 应用即可。

---

## 8. 日常运维

### 8.1 改配置生效

配置**只在启动时读取一次**，改完必须重启：

```bash
docker compose restart m5-dashboard     # 方案 A
sudo systemctl restart m5-dashboard     # 方案 B
```

### 8.2 令牌轮换（异地部署后最主要的运维动作）

各显式凭据会过期，续期统一流程是「**本机重新获取 → 覆盖节点配置 → 重启服务**」：

| 数据源 | 本机获取方式 | 节点侧动作 |
| --- | --- | --- |
| TRAE | 在装 TRAE 客户端处运行 `node trae-token.js` | 覆盖 `config/trae.json` → 重启 |
| DeepSeek 用量 | 浏览器 `JSON.parse(localStorage.userToken).value` | 覆盖 `deepseek.json` → 重启 |
| WorkBuddy | 本机运行签发助手的 `decrypt-token.js` | 覆盖 `workbuddy.json` → 重启 |
| MiMo / Qoder | 浏览器复制控制台请求头 Cookie | 覆盖 `mimo.json` / `qoder.json` → 重启 |
| MiniMax | 开放平台控制台「账户管理 → API 密钥」复制按量付费 Key | 覆盖 `minimax.json` → 重启（Key 长期有效，一般无需轮换） |

> `deepseekApiKey`（`sk-` 开头）长期有效，一般无需轮换。
> 各凭据的详细获取步骤见 [Credentials_Guide.md](file:///e:/AIProjects/HUAWEI_M5/Credentials_Guide.md)。

### 8.3 更新代码

```bash
# 节点上
cd /opt/m5-dashboard
# 覆盖新代码（或 git pull）后：
docker compose build && docker compose up -d
```

> 若改的是 `public/index.html` 等静态文件，只需重新上传并 `docker compose build`（镜像内置静态页）。
> 若只改 `config/`，无需重建镜像，直接 `restart` 即可。

### 8.4 日志与状态

```bash
docker compose logs -f m5-dashboard      # 实时日志
docker compose ps                        # 运行状态
docker stats m5-dashboard --no-stream    # 资源占用
```

---

## 9. 安全边界

| 边界 | 落实方式 |
| --- | --- |
| 不暴露公网 | 服务仅监听局域网；**不要**在节点上做公网端口映射 / 反向代理 |
| 限制来源网段 | compose 端口可改为 `"<ub节点IP>:8787:8787"` 只绑内网网卡 |
| 主机防火墙 | `sudo ufw allow from 192.168.1.0/24 to any port 8787 proto tcp` |
| 凭据不外泄 | `config/*.json` 与 `data/` 已在 `.gitignore`；`config/` 不进镜像；API 不下发前端 |
| 只读采集 | Codex 只读额度接口，不导出/不刷新 OAuth；各平台接口均为只读调用 |

---

## 10. 已知风险与检查清单

### 10.1 已知风险

1. **Docker Hub 直连不可达** → 用第 3.3 节的镜像代理预取或加速器；优先方式一（不影响现有容器）。
2. **Codex 出网依赖**：节点若无法访问 `chatgpt.com`，Codex 卡会失败（其余卡不受影响）。
3. **令牌短命**：TRAE 约两周、WorkBuddy / MiMo / Qoder / DeepSeek 用量 Token 均会过期，
   需要人工轮换，无自动续期（TRAE 刻意关闭自动续期以免踢掉其它客户端登录态）。
   MiniMax 例外：走官方公开接口，API Key 长期有效，通常无需轮换。
4. **Codex 登录态会过期**：`config/codex.json` 里的 `access_token` 有有效期，看板不自动续期；
   过期后需重新登录并覆盖该文件（旧版「本机不宜再跑 codex」的限制已随纯 HTTP 改造消失）。
5. **内部接口非公开**：多个数据源走平台网页内部接口，可能随平台改版失效，需留意卡片报错。
6. **`data/` 未持久化**（默认 compose）：容器重建会丢失 WorkBuddy「当日消耗」基线，建议按 5.2 节补挂载。
7. **`config` 只读挂载**：WorkBuddy 自动续期写回不生效（与「推荐留空 refreshUrl」一致，属预期）。
8. **时区**：必须保证 `TZ=Asia/Shanghai`（镜像/compose/unit 均已设置），否则「今日」统计错位。

### 10.2 上线检查清单

- [ ] 节点满足第 3.1 节系统与运行时要求，时间已同步
- [ ] 已确认节点到 DeepSeek / 国内平台 / `chatgpt.com` 的出网可达性
- [ ] 已处理 Docker Hub 不可达（预取基镜像或配加速器）
- [ ] 代码已上传至 `/opt/m5-dashboard`，`config/*.json` 已就位
- [ ] `config/codex.json` 已填入 `~/.codex/auth.json` 的内容（节点无需安装 codex CLI）
- [ ] `docker compose build` 与 `up -d` 成功，日志出现「已启动」
- [ ] `?refresh=1` 下各卡片 `ok` 状态符合预期
- [ ] 局域网另一台机器可访问 `http://<节点IP>:8787/`
- [ ] 平板 `dashboardUrl` 已改成节点 IP（纯 IP，非 `.local`）
- [ ] 防火墙/端口绑定已按第 9 节收口，未暴露公网
- [ ] 已记录各令牌的到期时间，纳入轮换计划

---

## 附：关键文件

- 服务代码：[server.js](file:///e:/AIProjects/HUAWEI_M5/dashboard/server.js)、[collector.js](file:///e:/AIProjects/HUAWEI_M5/dashboard/collector.js)、[public/index.html](file:///e:/AIProjects/HUAWEI_M5/dashboard/public/index.html)
- 容器制品：[Dockerfile](file:///e:/AIProjects/HUAWEI_M5/dashboard/Dockerfile)、[docker-compose.yml](file:///e:/AIProjects/HUAWEI_M5/dashboard/docker-compose.yml)
- 配置模板：[config/service.example.json](file:///e:/AIProjects/HUAWEI_M5/dashboard/config/service.example.json) 等 `*.example.json`
- 凭据获取：[Credentials_Guide.md](file:///e:/AIProjects/HUAWEI_M5/Credentials_Guide.md)
- 调研与实测结论：[Huawei_M5_AI_Usage_Dashboard_Research.md](file:///e:/AIProjects/HUAWEI_M5/Huawei_M5_AI_Usage_Dashboard_Research.md)