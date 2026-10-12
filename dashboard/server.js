'use strict';

// 阶段 A：只读采集 + 网页看板
// - GET /            看板页面（public/index.html）
// - GET /api/usage   聚合的只读 JSON（Codex 额度 + DeepSeek 余额/用量）
// 密钥仅保存在本机 config/ 目录（按产品拆分），不下发给前端。

const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  collectCodex,
  collectDeepseek,
  collectDeepseekUsage,
  collectWorkbuddy,
  refreshWorkbuddyToken,
  collectTrae,
  collectMimo,
  collectQoder,
  collectMinimax,
} = require('./collector');

const ROOT = __dirname;
const CONFIG_DIR = path.join(ROOT, 'config');
// Codex 凭据直接放在 config/codex.json：把 ~/.codex/auth.json 的内容整体复制进来即可。
const CODEX_CREDS_FILE = path.join(CONFIG_DIR, 'codex.json');

// 配置按产品拆分：service 为服务级共享项，codex / deepseek 各产品独立文件，
// 不把多个产品的配置混在同一个 json 里。
function readConfigFile(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, name), 'utf8'));
  } catch (_) {
    return {};
  }
}

function loadConfig() {
  const service = readConfigFile('service.json');
  const deepseek = readConfigFile('deepseek.json');
  const workbuddy = readConfigFile('workbuddy.json');
  const trae = readConfigFile('trae.json');
  const mimo = readConfigFile('mimo.json');
  const qoder = readConfigFile('qoder.json');
  const minimax = readConfigFile('minimax.json');
  return {
    host: service.host ?? '0.0.0.0',
    port: service.port ?? 8787,
    // 自适应刷新参数：基准间隔 / 上限 / 退避倍数（连续两次数据无变化则翻倍）。
    refresh: {
      baseMs: Math.max(10, Number(service.refresh?.baseSeconds ?? 60)) * 1000,
      maxMs: Math.max(60, Number(service.refresh?.maxSeconds ?? 7200)) * 1000,
      factor: Number(service.refresh?.factor ?? 2) || 2,
    },
    // Codex 凭据文件：config/codex.json（内含 tokens.access_token / tokens.account_id）。
    deepseekApiKey: deepseek.deepseekApiKey ?? '',
    deepseekPlatformToken: deepseek.deepseekPlatformToken ?? '',
    // WorkBuddy：服务端只持有只读令牌，不依赖本机登录态文件，便于异地部署。
    workbuddy: {
      accessToken: workbuddy.accessToken ?? '',
      refreshToken: workbuddy.refreshToken ?? '',
      uid: workbuddy.uid ?? '',
      domain: workbuddy.domain ?? 'www.workbuddy.cn',
      refreshUrl: workbuddy.refreshUrl ?? '',
    },
    // TRAE CN：只持有只读登录态令牌，不读取本机文件；令牌过期后手工重取（见 trae-token.js）。
    trae: {
      cloudIdeJwt: trae.cloudIdeJwt ?? '',
      deviceId: trae.deviceId ?? '',
      machineId: trae.machineId ?? '',
    },
    // Xiaomi MiMo：只持有只读网页登录态 Cookie，不依赖本机文件，便于异地部署。
    mimo: {
      cookie: mimo.cookie ?? '',
    },
    // Qoder CN：只持有只读网页登录态 Cookie；site 选 cn / intl，默认 cn（qoder.com.cn）。
    qoder: {
      cookie: qoder.cookie ?? '',
      site: qoder.site ?? 'cn',
    },
    // MiniMax 开放平台：按量付费 API Key，官方公开余额接口，无需网页登录态。
    // region 选 cn / intl，默认 cn（api.minimaxi.com）；可用 baseUrl 覆盖接口根地址。
    minimax: {
      apiKey: minimax.apiKey ?? '',
      region: minimax.region ?? 'cn',
      baseUrl: minimax.baseUrl ?? '',
    },
  };
}

// 令牌续期成功后回写配置，保持写入原子性（先写临时文件再改名）。
function persistWorkbuddyToken(newToken) {
  const target = path.join(CONFIG_DIR, 'workbuddy.json');
  const tmp = target + '.tmp';
  try {
    const cur = readConfigFile('workbuddy.json');
    fs.writeFileSync(tmp, JSON.stringify({ ...cur, accessToken: newToken }, null, 2), 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch (e) {
    console.log('[m5-dashboard] WorkBuddy 令牌续期写回失败:', e.message);
    return false;
  }
}

// WorkBuddy「当日消耗」快照：平台接口只有周期粒度用量、没有日期粒度，
// 故以「当日首次读数」为基线，对 Σ周期已用 做差近似当日消耗。
const STATE_DIR = path.join(ROOT, 'data');
const WB_STATE_FILE = path.join(STATE_DIR, 'workbuddy-state.json');

function localDateKey(d = new Date()) {
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readWbState() {
  try { return JSON.parse(fs.readFileSync(WB_STATE_FILE, 'utf8')); } catch (_) { return {}; }
}

function writeWbState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = WB_STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, WB_STATE_FILE);
  } catch (e) {
    console.log('[m5-dashboard] WorkBuddy 当日消耗快照写入失败:', e.message);
  }
}

// 估算当日消耗：跨天、或换包/到期导致读数回退时重置基线，避免出现负值。
function withWorkbuddyDaily(result) {
  if (!result || !result.ok) return result;
  const today = localDateKey();
  const cur = Number(result.totalUsed) || 0;
  const st = readWbState();
  const base = Number(st.baseUsed);
  if (st.date !== today || !Number.isFinite(base) || cur < base) {
    writeWbState({ date: today, baseUsed: cur });
    result.todayUsed = 0;
  } else {
    result.todayUsed = Math.round((cur - base) * 100) / 100;
  }
  result.todayUsedEstimated = true;
  return result;
}

// MiniMax「当日消费」快照：官方按量付费只有余额接口、没有消费明细，
// 故按「同一自然日内可用余额的下滑量」累加近似（充值导致的余额上升不计入消耗）。
const MM_STATE_FILE = path.join(STATE_DIR, 'minimax-state.json');

function readMmState() {
  try { return JSON.parse(fs.readFileSync(MM_STATE_FILE, 'utf8')); } catch (_) { return {}; }
}

function writeMmState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = MM_STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, MM_STATE_FILE);
  } catch (e) {
    console.log('[m5-dashboard] MiniMax 当日消费快照写入失败:', e.message);
  }
}

function withMinimaxDaily(result) {
  if (!result || !result.ok) return result;
  const cur = Number(result.balance && result.balance.available);
  if (!Number.isFinite(cur)) return result;

  const today = localDateKey();
  const st = readMmState();
  const sameDay = st.date === today;
  const last = sameDay ? Number(st.lastAvailable) : NaN;
  let spent = sameDay ? Number(st.spent) || 0 : 0;

  // 余额下降即计入消费；余额上升视为充值，不计入。
  if (Number.isFinite(last) && cur < last) spent += last - cur;
  spent = Math.round(spent * 100) / 100;

  writeMmState({ date: today, lastAvailable: cur, spent });
  result.todaySpent = spent;
  result.todaySpentEstimated = true;
  return result;
}

const config = loadConfig();

// WorkBuddy 采集：令牌过期且配置了自动续期时，续期一次并回写配置后重试。
async function collectWorkbuddyWithRenew() {
  const wb = config.workbuddy;
  let result = await collectWorkbuddy({ token: wb.accessToken, uid: wb.uid, domain: wb.domain });
  if (!result.ok && result.authExpired && wb.refreshToken && wb.refreshUrl) {
    const newToken = await refreshWorkbuddyToken({ refreshToken: wb.refreshToken, refreshUrl: wb.refreshUrl });
    if (newToken) {
      wb.accessToken = newToken;
      persistWorkbuddyToken(newToken);
      result = await collectWorkbuddy({ token: newToken, uid: wb.uid, domain: wb.domain });
    }
  }
  return withWorkbuddyDaily(result);
}

// ---------------------------------------------------------------------------
// 按数据源的自适应刷新
// 每个源独立计时、独立退避：默认按基准间隔采集；连续两次「数据无变化」则间隔翻倍，
// 直到上限；一旦检测到数据变化立即回到基准间隔。手动点击卡片走 ?source=<name>
// 强制采集该源一次，并把它的间隔重置回基准。其他源不受影响，各按自身节奏走。
// ---------------------------------------------------------------------------
const STAGGER_MS = 2000;   // 各源首次采集错峰，避免同时打上游
const JITTER_RATIO = 0.1;  // 间隔抖动 ±10%，避免多个源长期同步

// 每个条目返回「响应体里的部分字段」；DeepSeek 卡片跨两个接口（余额 + 今日用量），
// 故一次采集同时产出 deepseek 与 deepseekUsage 两个字段。
const SOURCE_COLLECTORS = {
  codex: async () => ({ codex: await collectCodex({ authFile: CODEX_CREDS_FILE }) }),
  deepseek: async () => {
    const [deepseek, deepseekUsage] = await Promise.all([
      collectDeepseek({ apiKey: config.deepseekApiKey }),
      collectDeepseekUsage({ token: config.deepseekPlatformToken }),
    ]);
    return { deepseek, deepseekUsage };
  },
  workbuddy: async () => ({ workbuddy: await collectWorkbuddyWithRenew() }),
  trae: async () => ({
    trae: await collectTrae({
      jwt: config.trae.cloudIdeJwt,
      deviceId: config.trae.deviceId,
      machineId: config.trae.machineId,
    }),
  }),
  mimo: async () => ({ mimo: await collectMimo({ cookie: config.mimo.cookie }) }),
  qoder: async () => ({ qoder: await collectQoder({ cookie: config.qoder.cookie, site: config.qoder.site }) }),
  minimax: async () => ({
    minimax: withMinimaxDaily(await collectMinimax({
      apiKey: config.minimax.apiKey,
      region: config.minimax.region,
      baseUrl: config.minimax.baseUrl || undefined,
    })),
  }),
};
const SOURCES = Object.keys(SOURCE_COLLECTORS);

// 每源状态：patch 为响应体片段，fingerprint 用于判断数据是否变化。
const sourceState = {};

function getState(name) {
  if (!sourceState[name]) {
    sourceState[name] = {
      patch: null, fingerprint: null, intervalMs: config.refresh.baseMs,
      at: 0, timer: null, collecting: null,
    };
  }
  return sourceState[name];
}

// 递归按 key 排序序列化，避免对象键序差异造成「假变化」。
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function withJitter(ms) {
  return Math.round(ms * (1 + (Math.random() * 2 - 1) * JITTER_RATIO));
}

// ---------------------------------------------------------------------------
// 后台采集裁剪：页面上被关闭（隐藏）的模块，服务端也不再采集，避免浪费上游额度。
// 前端在打开页面及每次切换显隐时，把当前隐藏集合 POST 到 /api/visibility；
// 该集合持久化到 data/，服务重启后依然生效。
// ---------------------------------------------------------------------------
const VIS_STATE_FILE = path.join(STATE_DIR, 'visibility-state.json');
let hiddenSources = new Set();
try {
  const arr = JSON.parse(fs.readFileSync(VIS_STATE_FILE, 'utf8'));
  if (Array.isArray(arr)) arr.forEach((s) => { if (SOURCES.includes(s)) hiddenSources.add(s); });
} catch (_) {}

function persistHiddenSources() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = VIS_STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Array.from(hiddenSources)), 'utf8');
    fs.renameSync(tmp, VIS_STATE_FILE);
  } catch (e) {
    console.log('[m5-dashboard] 显隐状态写入失败:', e.message);
  }
}

// 更新隐藏集合：新隐藏的源立即停表；重新显示的源尽快补采一次。
function setHiddenSources(list) {
  const prev = hiddenSources;
  const next = new Set(Array.isArray(list) ? list.filter((s) => SOURCES.includes(s)) : []);
  hiddenSources = next;
  for (const name of SOURCES) {
    const wasHidden = prev.has(name);
    const nowHidden = next.has(name);
    if (nowHidden === wasHidden) continue;
    const st = getState(name);
    if (nowHidden) {
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    } else {
      scheduleSource(name, withJitter(st.patch ? 2000 : 1000));
    }
  }
  persistHiddenSources();
  return Array.from(hiddenSources);
}

function scheduleSource(name, delayMs) {
  const st = getState(name);
  if (st.timer) clearTimeout(st.timer);
  st.timer = null;
  if (hiddenSources.has(name)) return; // 页面上已关闭的模块不再排下一次采集
  st.timer = setTimeout(() => { runSource(name); }, delayMs);
}

// 采集单个源一次；manual 时强制回到基准间隔。
async function collectSource(name, manual) {
  const st = getState(name);
  let patch;
  try {
    patch = await SOURCE_COLLECTORS[name]();
  } catch (e) {
    patch = { [name]: { ok: false, error: e.message } };
  }
  const fingerprint = stableStringify(patch);
  const changed = fingerprint !== st.fingerprint;
  st.patch = patch;
  st.fingerprint = fingerprint;
  st.at = Date.now();
  st.intervalMs = (manual || changed)
    ? config.refresh.baseMs
    : Math.min(st.intervalMs * config.refresh.factor, config.refresh.maxMs);
  return patch;
}

// 触发一次采集（同一源在途时复用同一 Promise），完成后重排下一次。
async function runSource(name, manual) {
  const st = getState(name);
  // 已关闭的模块不自动采集（手动强制刷新仍允许，便于调试）。
  if (hiddenSources.has(name) && !manual) return st.patch;
  if (!st.collecting) {
    st.collecting = collectSource(name, manual).finally(() => { st.collecting = null; });
  }
  await st.collecting;
  if (manual) st.intervalMs = config.refresh.baseMs;
  scheduleSource(name, withJitter(st.intervalMs));
  return st.patch;
}

// 首次请求时把尚未采集过的源立即补齐（并行），避免页面长时间空白。
async function ensureInitialized() {
  const pending = SOURCES.filter((n) => !hiddenSources.has(n) && !getState(n).patch);
  if (pending.length) await Promise.all(pending.map((n) => runSource(n, false)));
}

// 汇总响应体：各源最新片段 + 各源自己的更新时间 + 当前隐藏（关闭）的模块。
function assembleUsage() {
  const payload = {
    updatedAt: new Date().toISOString(),
    // 显隐状态以服务端为准，前端据此跟随，避免多设备之间互相覆盖。
    hiddenSources: Array.from(hiddenSources),
  };
  for (const name of SOURCES) {
    const st = getState(name);
    if (!st.patch) continue;
    Object.assign(payload, st.patch);
    payload[name + 'UpdatedAt'] = new Date(st.at).toISOString();
  }
  return payload;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const pubDir = path.join(ROOT, 'public');
  const full = path.normalize(path.join(pubDir, rel));
  // 必须精确等于 public 目录或以 public + 分隔符 开头，避免 public-data/ 之类同级目录被前缀绕过
  if (full !== pubDir && !full.startsWith(pubDir + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
    // 静态资源禁用缓存：平板 WebView 会强缓存 HTML，导致改版后仍加载旧页面
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

// 读取请求体（限制大小，仅用于 /api/visibility 这类小 JSON）。
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 16384) { resolve(null); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(null));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/visibility') {
    // 前端上报当前隐藏（关闭）的模块集合，服务端据此裁剪后台采集。
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '仅支持 POST' }));
      return;
    }
    let parsed = null;
    try { parsed = JSON.parse((await readBody(req)) || '{}'); } catch (_) {}
    if (!parsed || !Array.isArray(parsed.hidden)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '请求体需为 { hidden: ["源名", ...] }' }));
      return;
    }
    const current = setHiddenSources(parsed.hidden);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ hidden: current }));
    return;
  }
  if (url.pathname === '/api/usage') {
    const source = url.searchParams.get('source');
    const force = url.searchParams.has('refresh');
    try {
      if (source) {
        if (!SOURCES.includes(source)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `未知数据源：${source}` }));
          return;
        }
        // 手动刷新：立即采集该源一次，并把它的自适应间隔重置回基准。
        await runSource(source, true);
      } else if (force) {
        // 强制刷新全部源（保留调试入口）；已关闭的模块跳过。
        await Promise.all(SOURCES.filter((n) => !hiddenSources.has(n)).map((n) => runSource(n, true)));
      } else {
        // 常规读取：只补齐从未采集过的源，其余直接返回各自最新缓存。
        await ensureInitialized();
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(assembleUsage()));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  serveStatic(res, url.pathname);
});

server.listen(config.port, config.host, () => {
  const base = config.refresh.baseMs / 1000;
  const max = config.refresh.maxMs / 1000;
  console.log(`[m5-dashboard] 已启动: http://${config.host}:${config.port}  (自适应刷新 ${base}s → ${max}s)`);
  // 各数据源自调度，首次错峰启动，之后按各自退避节奏运行。
  SOURCES.forEach((name, i) => scheduleSource(name, i * STAGGER_MS));
  if (!readConfigFile('codex.json').tokens?.access_token) console.log('[m5-dashboard] 提示: config/codex.json 里缺少 tokens.access_token，Codex 额度将显示未配置（把 ~/.codex/auth.json 的内容复制进去）。');
  if (!config.deepseekApiKey) console.log('[m5-dashboard] 提示: config/deepseek.json 里 deepseekApiKey 为空，DeepSeek 余额将显示未配置。');
  if (!config.deepseekPlatformToken) console.log('[m5-dashboard] 提示: config/deepseek.json 里 deepseekPlatformToken 为空，DeepSeek 今日用量将显示未配置。');
  if (!config.workbuddy.accessToken || !config.workbuddy.uid) console.log('[m5-dashboard] 提示: config/workbuddy.json 里 accessToken/uid 为空，WorkBuddy 积分将显示未配置。');
  if (!config.trae.cloudIdeJwt) console.log('[m5-dashboard] 提示: config/trae.json 里 cloudIdeJwt 为空，TRAE 积分将显示未配置（可用 node trae-token.js 提取）。');
  if (!config.mimo.cookie) console.log('[m5-dashboard] 提示: config/mimo.json 里 cookie 为空，Xiaomi MiMo 额度/余额将显示未配置。');
  if (!config.qoder.cookie) console.log('[m5-dashboard] 提示: config/qoder.json 里 cookie 为空，Qoder CN 用量将显示未配置。');
  if (!config.minimax.apiKey) console.log('[m5-dashboard] 提示: config/minimax.json 里 apiKey 为空，MiniMax 余额将显示未配置。');
});