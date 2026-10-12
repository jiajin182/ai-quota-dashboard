'use strict';

// 数据采集模块：Codex 额度 + DeepSeek 余额
// Codex 侧只读本地凭据文件里的 access_token 用于查询额度，不外发、不写回、不做续期。

const fs = require('fs');

// ---- Codex：读 ~/.codex/auth.json 形式的 OAuth 凭据，直接调用 ChatGPT WHAM 用量接口 ----
// 该接口即 codex CLI 的 account/rateLimits/read 内部调用的同一上游端点，属未公开接口，需容错解析。
// 不依赖本机 codex 二进制，便于容器 / Ubuntu 环境部署。
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

// 仅本地解析 JWT 的 exp 声明用于提前提示过期，不做验签、不落盘、不外发。
function decodeJwtExp(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const exp = JSON.parse(json).exp;
    return typeof exp === 'number' ? exp : null;
  } catch (_) {
    return null;
  }
}

// 时间戳单位双判：> 1e10 视为毫秒，否则视为秒。
function epochToIso(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const d = new Date(value > 1e10 ? value : value * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function labelForWindow(minutes) {
  if (minutes === 300) return '5 小时窗口';
  if (minutes === 10080) return '每周窗口';
  if (minutes === 43200) return '每月窗口';
  if (minutes === 1440) return '每日窗口';
  if (typeof minutes === 'number' && minutes > 0) return `${minutes} 分钟窗口`;
  return '额度窗口';
}

function normalizeCodex(usage) {
  const rl = (usage && usage.rate_limit) || {};

  const windows = [];
  for (const slot of ['primary', 'secondary']) {
    const w = rl[`${slot}_window`];
    if (!w || typeof w.used_percent !== 'number') continue;
    const minutes = typeof w.limit_window_seconds === 'number' ? Math.round(w.limit_window_seconds / 60) : null;
    const used = w.used_percent;
    windows.push({
      slot,
      windowMinutes: minutes,
      label: labelForWindow(minutes),
      usedPercent: used,
      remainingPercent: Math.max(0, Math.min(100, 100 - used)),
      resetsAt: epochToIso(w.reset_at),
    });
  }

  return {
    planType: usage && usage.plan_type != null ? usage.plan_type : null,
    credits: (usage && usage.credits) || null,
    resetCredits: (usage && usage.rate_limit_reset_credits && usage.rate_limit_reset_credits.available_count) || 0,
    windows,
  };
}

async function collectCodex({ authFile, timeoutMs = 15000 } = {}) {
  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  } catch (e) {
    return { ok: false, error: `读取 Codex 凭据失败（${authFile}）：${e.message}` };
  }

  const tokens = creds.tokens || {};
  const accessToken = tokens.access_token;
  const accountId = tokens.account_id;
  if (!accessToken) return { ok: false, error: 'Codex 凭据缺少 tokens.access_token' };

  const exp = decodeJwtExp(accessToken);
  if (exp && exp * 1000 <= Date.now()) {
    return { ok: false, error: 'Codex 登录态已过期，请重新登录 codex 后更新 config 中的凭据文件' };
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(CODEX_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
        Accept: 'application/json',
        // 镜像 codex CLI 的 UA，降低被上游判为非官方客户端的概率。
        'User-Agent': 'codex_cli_rs/0.0.0 (m5-dashboard)',
      },
      signal: ctrl.signal,
    });
    if (r.status === 401 || r.status === 403) {
      return { ok: false, error: `Codex 凭据被拒绝（HTTP ${r.status}），登录态可能已失效` };
    }
    if (!r.ok) return { ok: false, error: `Codex 用量接口返回 HTTP ${r.status}` };
    return { ok: true, ...normalizeCodex(await r.json()) };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `Codex 用量接口超时（${timeoutMs}ms）` : e.message };
  } finally {
    clearTimeout(t);
  }
}

// ---- DeepSeek：GET /user/balance（仅余额）----

async function collectDeepseek({ apiKey, timeoutMs = 10000 } = {}) {
  if (!apiKey) return { ok: false, error: '未配置 DeepSeek API Key（config/deepseek.json）' };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const data = await r.json();
    return {
      ok: true,
      isAvailable: data.is_available ?? null,
      balanceInfos: Array.isArray(data.balance_infos) ? data.balance_infos : [],
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `超时（${timeoutMs}ms）` : e.message };
  } finally {
    clearTimeout(t);
  }
}

// ---- DeepSeek：平台内部用量接口（消费/请求数/tokens）----
// 说明：DeepSeek 官方 API 只有余额，没有账户级用量接口。消费/请求数/tokens
// 只能通过平台网页的内部接口获取，认证使用网页登录态 userToken
// （浏览器执行 JSON.parse(localStorage.userToken).value 得到），非公开接口，可能失效。

const DS_PLATFORM_BASE = 'https://platform.deepseek.com/api/v0/usage';

function dsPlatformHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'x-client-platform': 'web',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function todayLocalString() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function dsGetJson(url, token, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: dsPlatformHeaders(token), signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// 把平台返回的按天明细汇总成 { date -> {tokens, requests, cost, ...} }。
// amount 响应的 biz_data 是对象 { total, days }；cost 响应的 biz_data 是数组。
function summarizePlatformDays(amountBizData, costBizData) {
  const byDate = new Map();
  const ensure = (date) => {
    if (!byDate.has(date)) {
      byDate.set(date, { date, tokens: 0, cacheHit: 0, cacheMiss: 0, response: 0, requests: 0, cost: 0 });
    }
    return byDate.get(date);
  };

  const amountDays = (amountBizData && amountBizData.days) || [];
  for (const day of amountDays) {
    const row = ensure(day.date);
    for (const entry of day.data || []) {
      for (const u of entry.usage || []) {
        const amt = toNumber(u.amount);
        switch (u.type) {
          case 'PROMPT_CACHE_HIT_TOKEN': row.cacheHit += amt; row.tokens += amt; break;
          case 'PROMPT_CACHE_MISS_TOKEN': row.cacheMiss += amt; row.tokens += amt; break;
          case 'RESPONSE_TOKEN': row.response += amt; row.tokens += amt; break;
          case 'REQUEST': row.requests += amt; break;
        }
      }
    }
  }

  const costBlocks = Array.isArray(costBizData) ? costBizData : (costBizData ? [costBizData] : []);
  const costBlock = costBlocks.find((b) => b && b.days && b.days.length) || costBlocks[0] || {};
  for (const day of costBlock.days || []) {
    const row = ensure(day.date);
    for (const entry of day.data || []) {
      for (const u of entry.usage || []) row.cost += toNumber(u.amount);
    }
  }

  return { byDate, currency: costBlock.currency || 'CNY' };
}

// 平台接口即使鉴权失败也返回 HTTP 200，错误放在 { code, msg } 包裹里，
// 所以必须检查 code / biz_code，否则过期 Token 会被误判为"今日零用量"。
function platformEnvelopeError(payload) {
  if (!payload) return '平台未返回数据';
  if (payload.code != null && payload.code !== 0) return payload.msg || `平台返回 code ${payload.code}`;
  const d = payload.data;
  if (!d) return payload.msg || '平台未返回数据';
  if (d.biz_code != null && d.biz_code !== 0) return d.biz_msg || `平台返回 biz_code ${d.biz_code}`;
  return null;
}

async function collectDeepseekUsage({ token, timeoutMs = 10000 } = {}) {
  if (!token) {
    return { ok: false, error: '未配置平台用量 Token（config/deepseek.json 的 deepseekPlatformToken）' };
  }
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  try {
    const [amount, cost] = await Promise.all([
      dsGetJson(`${DS_PLATFORM_BASE}/amount?month=${month}&year=${year}`, token, timeoutMs),
      dsGetJson(`${DS_PLATFORM_BASE}/cost?month=${month}&year=${year}`, token, timeoutMs),
    ]);

    const envError = platformEnvelopeError(amount) || platformEnvelopeError(cost);
    if (envError) {
      const hint = /token|auth/i.test(envError) || amount.code === 40003
        ? '（用量 Token 无效或已过期，请重新获取）'
        : '';
      return { ok: false, error: envError + hint };
    }

    const amountBizData = amount.data.biz_data;
    const costBizData = cost.data.biz_data;
    const { byDate, currency } = summarizePlatformDays(amountBizData, costBizData);

    const today = byDate.get(todayLocalString()) || {
      date: todayLocalString(), tokens: 0, cacheHit: 0, cacheMiss: 0, response: 0, requests: 0, cost: 0,
    };
    const monthTotal = [...byDate.values()].reduce(
      (acc, r) => ({
        tokens: acc.tokens + r.tokens,
        requests: acc.requests + r.requests,
        cost: acc.cost + r.cost,
      }),
      { tokens: 0, requests: 0, cost: 0 }
    );

    return { ok: true, currency, today, month: { month, year, ...monthTotal } };
  } catch (e) {
    const msg = e.name === 'AbortError' ? `超时（${timeoutMs}ms）` : e.message;
    const hint = /401|403/.test(String(e.message))
      ? '（用量 Token 无效或已过期，请重新获取）'
      : '';
    return { ok: false, error: msg + hint };
  }
}

// ---- WorkBuddy（腾讯 CodeBuddy 国内版）：只读余额查询 ----
// WorkBuddy 按积分（Credits）计费。用量接口是纯 Bearer-Token 的 HTTP 接口，不依赖本机文件，
// 因此看板服务可部署在另一台机器上，只需在 config/workbuddy.json 里配置令牌即可。
// 鉴权头：Authorization: Bearer <accessToken> + X-User-Id: <uid>；域名取登录态的 auth.domain。

// 余额接口路径存在版本差异，两条都尝试：
//   1) 带 /v2 的 get-user-resource，实测返回 data.Response.Data.Accounts[]
//   2) 不带 /v2 的 get-user-resource-summary，按积分包返回总额/已用/剩余
const WB_BALANCE_PATHS = [
  '/v2/billing/meter/get-user-resource',
  '/billing/meter/get-user-resource-summary',
];

function wbHeaders(token, uid) {
  return {
    Authorization: `Bearer ${token}`,
    'X-User-Id': uid,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };
}

function wbPickNumber(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v != null && v !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function wbPickString(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v != null && v !== '') return String(v);
  }
  return null;
}

// 兼容两种响应形态：嵌套的 data.Response.Data.Accounts[]，或按积分包的 Packages/Resources 数组。
function wbFindAccounts(data) {
  const roots = [data && data.Response && data.Response.Data, data && data.Data, data];
  const arrayKeys = ['Accounts', 'Packages', 'Resources', 'Items', 'List'];
  for (const root of roots) {
    if (!root) continue;
    if (Array.isArray(root)) return root;
    for (const key of arrayKeys) {
      if (Array.isArray(root[key])) return root[key];
    }
  }
  return [];
}

function wbNormalizePackages(accounts) {
  const packages = [];
  for (const a of accounts || []) {
    if (!a || typeof a !== 'object') continue;
    // 实测 v2 接口字段名为 CapacitySize / CycleCapacitySize（额度大小），
    // 并非 Capacity/Total/Quota，故必须带上 *Size 键，否则 total 恒为 null。
    // 一律优先「周期内」（Cycle*）口径：非 Cycle 字段是生命周期维度，体验版等
    // 每月刷新的包 CapacitySize/CapacityRemain 长期停在满额不回落，会虚高。
    const total = wbPickNumber(a, [
      'CycleCapacitySizePrecise', 'CycleCapacitySize', 'CapacitySizePrecise',
      'CapacitySize', 'CycleTotalCapacity', 'Capacity', 'TotalCapacity', 'Total', 'Quota', 'total',
    ]);
    // 优先取「周期内已用」（Cycle*）：实测体验版 CapacityUsed 恒为 0，
    // 只有 CycleCapacityUsed 才反映真实消耗，否则按日快照会永远为 0。
    const used = wbPickNumber(a, [
      'CycleCapacityUsedPrecise', 'CycleCapacityUsed', 'CycleUsedCapacity',
      'CapacityUsedPrecise', 'CapacityUsed', 'Used', 'UsedAmount', 'used',
    ]);
    // 剩余同样必须优先 Cycle*：实测体验版 CapacityRemain=500（满额）而
    // CycleCapacityRemainPrecise=243.72，取前者会把剩余积分算多一个周期消耗量。
    const remain = wbPickNumber(a, [
      'CycleCapacityRemainPrecise', 'CycleCapacityRemain', 'CycleRemainCapacity',
      'CapacityRemainPrecise', 'CapacityRemain',
      'Remain', 'Remaining', 'Available', 'Balance', 'remain',
    ]);
    packages.push({
      name: wbPickString(a, ['PackageName', 'PackageName_', 'packageName', 'Name', 'name']) || '积分包',
      count: wbPickNumber(a, ['TotalCount', 'Count', 'count']),
      remain: remain != null ? remain : (total != null && used != null ? total - used : null),
      total,
      used,
      cycleStart: wbPickString(a, ['CycleStartTime', 'cycleStartTime']),
      cycleEnd: wbPickString(a, ['CycleEndTime', 'cycleEndTime', 'ExpireTime', 'expireTime']),
      // 积分包类型码与「扣减结束时间」（真正的到期时间），计算到期积分要用。
      code: wbPickString(a, ['PackageCode', 'packageCode']),
      deductionEnd: a.DeductionEndTime != null ? a.DeductionEndTime : a.deductionEndTime,
    });
  }
  return packages;
}

// 解析接口返回的 "YYYY-MM-DD HH:mm:ss"（本地时区），无效返回 NaN。
function wbParseTime(s) {
  if (!s) return NaN;
  return new Date(String(s).replace(' ', 'T')).getTime();
}

// 取积分包类型码中的稳定序号，如 TCACA_code_008_xxx -> 8。
function wbCodeNum(code) {
  const m = /code_(\d+)/.exec(String(code || ''));
  return m ? Number(m[1]) : null;
}

// 客户端 edge-sync 的展示规则（已核对源码）：
//   isDaily  = PackageCode === CommodityCode.free(code_001)
//   endTime  = isDaily ? CycleEndTime : DeductionEndTime
//   showExpireAt = 该码不在 onlyRefreshCodes 中
// onlyRefreshCodes（月包/试用包等）只「每月刷新」不「到期」，因此不计入到期积分；
// 否则会把「体验版 500 分/每月刷新」误当成 2026-10-31 到期。
const WB_DAILY_CODE_NUMS = new Set([1]);
const WB_ONLY_REFRESH_CODE_NUMS = new Set([2, 3, 5, 8, 23, 26, 27, 28, 35, 37, 39, 40]);

function wbTimeValue(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  if (/^\d+$/.test(String(v))) return Number(v);
  return wbParseTime(v);
}

// 每个积分包的「到期时间 + 剩余积分」，供前端按 3/7 天窗口汇总（与 TRAE 的
// packExpiry 同构）。到期时间取法严格对齐客户端，避免口径不一致。
function wbPackExpiry(packages) {
  const out = [];
  for (const p of packages || []) {
    const remain = Number(p.remain);
    if (!Number.isFinite(remain) || remain <= 0) continue;
    const num = wbCodeNum(p.code);
    if (num != null && WB_ONLY_REFRESH_CODE_NUMS.has(num)) continue; // 只刷新，不计到期
    let ts = WB_DAILY_CODE_NUMS.has(num) ? wbParseTime(p.cycleEnd) : wbTimeValue(p.deductionEnd);
    if (!Number.isFinite(ts)) ts = wbParseTime(p.cycleEnd); // 兜底
    if (!Number.isFinite(ts)) continue;
    out.push({ until: new Date(ts).toISOString(), remain });
  }
  return out;
}

// 平台接口即使鉴权失败也可能返回 HTTP 200，错误放在 code/msg 里，必须显式判断。
function wbEnvelopeError(payload) {
  if (!payload) return '接口未返回数据';
  const code = payload.code != null ? Number(payload.code) : null;
  if (code != null && code !== 0) return payload.msg || `接口返回 code ${payload.code}`;
  const d = payload.data;
  const dCode = d && d.code != null ? Number(d.code) : null;
  if (dCode != null && dCode !== 0) return d.msg || `接口返回 code ${d.code}`;
  return null;
}

function wbIsAuthError(msg) {
  return /token|auth|登录|过期|未授权|失效|401|403/i.test(String(msg || ''));
}

async function wbPostJson(url, token, uid, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: wbHeaders(token, uid),
      body: '{}',
      signal: ctrl.signal,
    });
    let body = null;
    try { body = await r.json(); } catch (_) {}
    return { httpStatus: r.status, body };
  } finally {
    clearTimeout(t);
  }
}

async function collectWorkbuddy({ token, uid, domain, timeoutMs = 10000 } = {}) {
  if (!token) return { ok: false, error: '未配置 WorkBuddy 令牌（config/workbuddy.json 的 accessToken）' };
  if (!uid) return { ok: false, error: '未配置 WorkBuddy uid（config/workbuddy.json 的 uid）' };
  const base = `https://${String(domain || 'www.workbuddy.cn')
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')}`;

  let lastErr = '未知错误';
  for (const path of WB_BALANCE_PATHS) {
    try {
      const { httpStatus, body } = await wbPostJson(base + path, token, uid, timeoutMs);
      if (httpStatus === 401 || httpStatus === 403) {
        return {
          ok: false,
          authExpired: true,
          error: `令牌无效或已过期（HTTP ${httpStatus}），请重新导出 accessToken`,
        };
      }
      if (httpStatus === 404) { lastErr = `${path} 返回 404`; continue; } // 路径不适用，试下一条
      if (httpStatus < 200 || httpStatus >= 300) { lastErr = `HTTP ${httpStatus}`; continue; }

      const envErr = wbEnvelopeError(body);
      if (envErr) {
        if (wbIsAuthError(envErr)) {
          return { ok: false, authExpired: true, error: `${envErr}（令牌无效或已过期，请重新导出）` };
        }
        lastErr = envErr;
        continue;
      }

      const data = body && body.data;
      const packages = wbNormalizePackages(wbFindAccounts(data));
      const totalRemain = packages.reduce((s, p) => s + (Number(p.remain) || 0), 0);
      const totalUsed = packages.reduce((s, p) => s + (Number(p.used) || 0), 0);
      return {
        ok: true,
        source: path,
        domain: base,
        planName: wbPickString(data || {}, ['PlanName', 'planName']) || null,
        packages,
        totalRemain: Math.round(totalRemain * 100) / 100,
        // Σ周期内已用，供服务端做「当日消耗」快照差值。
        totalUsed: Math.round(totalUsed * 100) / 100,
        packExpiry: wbPackExpiry(packages),
      };
    } catch (e) {
      lastErr = e.name === 'AbortError' ? `超时（${timeoutMs}ms）` : e.message;
    }
  }
  return { ok: false, error: lastErr };
}

// 长效令牌续期（可选）：仅当 config 里显式配置 refreshUrl 时启用。
// 腾讯未公开该端点，社区亦标注「长期刷新未实测」，故按通用 OAuth refresh 约定实现；
// 失败不影响主流程，仅提示重新授权。
async function refreshWorkbuddyToken({ refreshToken, refreshUrl, timeoutMs = 10000 } = {}) {
  if (!refreshToken || !refreshUrl) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(refreshUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${refreshToken}`,
      },
      body: JSON.stringify({ refreshToken, grantType: 'refresh_token' }),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const body = await r.json().catch(() => null);
    const d = (body && (body.data || body.result)) || body || {};
    const token =
      d.accessToken || d.access_token || d.token ||
      (body && (body.accessToken || body.access_token));
    return token ? String(token) : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---- TRAE CN：积分额度 ----
// 说明：TRAE CN 用「积分」计量，官方 API 不开放额度查询；额度只能通过 IDE 的
// 内部接口读取，认证用登录态令牌 Cloud-IDE-JWT。该令牌会过期，到期后用
// dashboard/trae-token.js 从本机已登录的客户端重新提取，覆盖 config/trae.json 即可。
// 刻意不做自动续期：TRAE 的 ExchangeToken 会轮换整个令牌族，会把其它客户端的
// 登录态一起踢掉（trae2api 亦默认关闭自刷新），故看板只做只读、被动使用令牌。

const TRAE_CN_USAGE_URL = 'https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage';

function traeHeaders(jwt, deviceId, machineId) {
  const h = {
    Authorization: `Cloud-IDE-JWT ${jwt}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };
  // 设备头非必需，但部分内部接口会校验，配置了就一直带上。
  if (deviceId) h['x-device-id'] = String(deviceId);
  if (machineId) h['x-machine-id'] = String(machineId);
  return h;
}

// TRAE 的响应是 { code, msg, data } 包裹，即使鉴权失败也可能返回 HTTP 200，
// 必须先看 code，否则过期令牌会被误判成"零额度"。
function traeEnvelopeError(payload) {
  if (!payload || typeof payload !== 'object') return '接口未返回数据';
  const code = payload.code != null ? Number(payload.code) : null;
  if (code != null && code !== 0) {
    return payload.msg || payload.message || `接口返回 code ${payload.code}`;
  }
  return null;
}

// 权益包数组的字段名在版本间有差异，按常见键逐个探测（含一层嵌套）。
function traeFindPacks(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data)) return data;
  const keys = [
    'user_entitlement_pack_list', 'userEntitlementPackList',
    'entitlement_packs', 'entitlementPacks', 'entitlement_list', 'entitlementList',
    'entitlements', 'packs', 'resources', 'list', 'items',
  ];
  for (const k of keys) {
    if (Array.isArray(data[k])) return data[k];
  }
  for (const v of Object.values(data)) {
    if (v && typeof v === 'object') {
      const found = traeFindPacks(v);
      if (found.length) return found;
    }
  }
  return [];
}

// 每包的 usage.credits_amount 是该包「已消耗」的积分（实测：各包之和 == usage_summary.consumed_amount），
// 不是额度；额度总量只在 usage_summary.total_amount 里。故按包类型分组汇总消耗量。
function traeGroupPacks(packs) {
  const nowSec = Date.now() / 1000;
  const map = new Map();
  for (const p of packs || []) {
    if (!p || typeof p !== 'object') continue;
    const name = wbPickString(p, ['display_desc', 'displayDesc', 'pack_name', 'packName', 'name', 'title']) || '积分包';
    const u = p.usage && typeof p.usage === 'object' ? p.usage : {};
    const used = wbPickNumber(u, ['credits_amount', 'creditsAmount', 'amount']) || 0;
    const untilSec = wbPickNumber(p, ['expire_time', 'expireTime', 'end_time', 'endTime']);
    const status = wbPickNumber(p, ['status']);
    const active = (status == null || status === 1) && (untilSec == null || untilSec > nowSec);
    const g = map.get(name) || { name, count: 0, activeCount: 0, used: 0, until: null };
    g.count += 1;
    g.used += used;
    if (active) g.activeCount += 1;
    if (untilSec != null && (g.until == null || untilSec < g.until)) g.until = untilSec;
    map.set(name, g);
  }
  return [...map.values()].map((g) => ({
    name: g.name,
    count: g.count,
    activeCount: g.activeCount,
    used: Math.round(g.used * 100) / 100,
    until: g.until != null ? new Date(g.until * 1000).toISOString() : null,
  }));
}

// 逐包展开「到期时间 + 未用积分」，供前端按到期日汇总"将失效"的积分。
// 每包额度在 entitlement_base_info.quota.credits_limit，已用在 usage.credits_amount。
function traePackExpiry(packs) {
  const out = [];
  for (const p of packs || []) {
    if (!p || typeof p !== 'object') continue;
    const base = p.entitlement_base_info && typeof p.entitlement_base_info === 'object' ? p.entitlement_base_info : {};
    const limit = wbPickNumber(base.quota, ['credits_limit', 'creditsLimit', 'limit']) || 0;
    const used = p.usage && typeof p.usage === 'object'
      ? wbPickNumber(p.usage, ['credits_amount', 'creditsAmount', 'amount']) || 0
      : 0;
    const untilSec = wbPickNumber(p, ['expire_time', 'expireTime', 'end_time', 'endTime']);
    if (untilSec == null) continue;
    out.push({
      until: new Date(untilSec * 1000).toISOString(),
      remain: Math.max(0, Math.round((limit - used) * 100) / 100),
    });
  }
  return out;
}

async function collectTrae({ jwt, deviceId, machineId, timeoutMs = 10000 } = {}) {
  if (!jwt) return { ok: false, error: '未配置 TRAE 令牌（config/trae.json 的 cloudIdeJwt）' };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(TRAE_CN_USAGE_URL, {
      method: 'POST',
      headers: traeHeaders(jwt, deviceId, machineId),
      body: JSON.stringify({ require_usage: true, req_source: 0 }),
      signal: ctrl.signal,
    });

    let body = null;
    try { body = await r.json(); } catch (_) {}

    if (r.status === 401 || r.status === 403) {
      return { ok: false, authExpired: true, error: `HTTP ${r.status}（Cloud-IDE-JWT 无效或已过期，请重新提取）` };
    }
    if (r.status < 200 || r.status >= 300) return { ok: false, error: `HTTP ${r.status}` };

    const envErr = traeEnvelopeError(body);
    if (envErr) {
      if (wbIsAuthError(envErr)) {
        return { ok: false, authExpired: true, error: `${envErr}（令牌无效或已过期，请重新提取）` };
      }
      return { ok: false, error: envErr };
    }

    // 正常响应为扁平结构（无 code/data 包裹）；兼容 { data: {...} } 形态。
    const data = body && typeof body.data === 'object' && body.data ? body.data : body || {};
    const summary = data.usage_summary && typeof data.usage_summary === 'object' ? data.usage_summary : {};
    const totalAmount = wbPickNumber(summary, ['total_amount', 'totalAmount', 'total']);
    const consumed = wbPickNumber(summary, ['consumed_amount', 'consumedAmount', 'consumed', 'used']);
    const unlimited = totalAmount === -1;
    const totalLimit = !unlimited && totalAmount != null && totalAmount > 0 ? totalAmount : 0;
    const totalUsed = consumed || 0;
    const round2 = (n) => Math.round(n * 100) / 100;

    return {
      ok: true,
      plan: data.is_credits_billing ? 'Credits' : 'Free',
      isCreditsBilling: !!data.is_credits_billing,
      unlimited,
      totalLimit: round2(totalLimit),
      totalUsed: round2(totalUsed),
      totalRemain: totalLimit > 0 ? round2(Math.max(0, totalLimit - totalUsed)) : null,
      packs: traeGroupPacks(traeFindPacks(data)),
      packExpiry: traePackExpiry(traeFindPacks(data)),
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `超时（${timeoutMs}ms）` : e.message };
  } finally {
    clearTimeout(t);
  }
}

// ---- Xiaomi MiMo：开放平台控制台内部接口（今日用量 + 月度额度 + 套餐 + 余额）----
// 说明：MiMo 官方只公开推理 API，不公开账户级用量/余额接口。额度、余额与按天用量
// 只能通过平台网页控制台内部接口读取，鉴权使用网页登录态 Cookie（必须含
// api-platform_serviceToken 与 userId），Cookie 会过期，过期后需重新从浏览器复制。
// 非公开接口，可能随平台改版失效。接入思路参考开源实现 Sarctiann/opencode-quota
// （MIT）的 dist/lib/mimo.js，并补充 usage/detail 按天明细接口（实测所得）。

const MIMO_BASE = 'https://platform.xiaomimimo.com/api/v1';
const MIMO_USAGE_URL = `${MIMO_BASE}/tokenPlan/usage`;
const MIMO_DETAIL_URL = `${MIMO_BASE}/tokenPlan/detail`;
const MIMO_BALANCE_URL = `${MIMO_BASE}/balance`;
const MIMO_USAGE_DETAIL_URL = `${MIMO_BASE}/usage/detail`;
const MIMO_BILL_LIST_URL = `${MIMO_BASE}/usage/detail/list`;

// 只保留平台鉴权真正需要的 Cookie 字段，其余一律丢弃，避免携带无关隐私。
const MIMO_COOKIE_NAMES = [
  'api-platform_serviceToken',
  'userId',
  'api-platform_ph',
  'api-platform_slh',
];
const MIMO_REQUIRED_COOKIE_NAMES = ['api-platform_serviceToken', 'userId'];

function normalizeMimoCookie(raw) {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, error: '未配置 MiMo Cookie（config/mimo.json 的 cookie）' };
  }
  if (/[\r\n]/.test(raw)) return { ok: false, error: 'Cookie 含非法换行，请复制单行值' };

  const withoutPrefix = raw.trim().replace(/^cookie\s*:\s*/i, '');
  if (!withoutPrefix) return { ok: false, error: 'Cookie 为空' };

  const kept = new Map();
  for (const pair of withoutPrefix.split(';')) {
    const p = pair.trim();
    if (!p) continue;
    const sep = p.indexOf('=');
    if (sep <= 0) continue;
    const name = p.slice(0, sep).trim();
    const value = p.slice(sep + 1).trim();
    if (!MIMO_COOKIE_NAMES.includes(name) || !value || kept.has(name)) continue;
    kept.set(name, value);
  }
  if (MIMO_REQUIRED_COOKIE_NAMES.some((n) => !kept.has(n))) {
    return {
      ok: false,
      error: 'Cookie 缺少必需的 api-platform_serviceToken 或 userId（请从浏览器 /api/v1/balance 请求头复制完整 Cookie）',
    };
  }
  // POST 类接口要求把 api-platform_ph 作为 query 参数（去引号值），否则一律 401。
  const ph = (kept.get('api-platform_ph') || '').replace(/^"|"$/g, '');
  return {
    ok: true,
    cookie: MIMO_COOKIE_NAMES.filter((n) => kept.has(n))
      .map((n) => `${n}=${kept.get(n)}`)
      .join('; '),
    ph: ph || null,
  };
}

// 平台接口以 x-timeZone 为准划分"本月"，按本机时区上报。
function mimoTimeZone() {
  const utcOffset = -new Date().getTimezoneOffset();
  const sign = utcOffset >= 0 ? '+' : '-';
  const abs = Math.abs(utcOffset);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function mimoHeaders(cookie) {
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Cookie: cookie,
    Origin: 'https://platform.xiaomimimo.com',
    Referer: 'https://platform.xiaomimimo.com/',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'x-timeZone': mimoTimeZone(),
  };
}

// 平台响应统一为 { code, data }，code 非 0 视为失败（重定向到登录页也算鉴权失效）。
function mimoEnvelopeError(payload) {
  if (!payload || typeof payload !== 'object') return '接口未返回数据';
  const code = payload.code != null ? Number(payload.code) : null;
  if (code !== 0) return payload.msg || payload.message || `接口返回 code ${payload.code}`;
  if (!payload.data || typeof payload.data !== 'object') return '接口未返回数据';
  return null;
}

function mimoParseUsage(data) {
  const items = data.monthUsage && Array.isArray(data.monthUsage.items) ? data.monthUsage.items : null;
  const item = items && items.find((x) => x && x.name === 'month_total_token');
  const used = item && typeof item.used === 'number' ? item.used : null;
  const limit = item && typeof item.limit === 'number' ? item.limit : null;
  if (used === null || limit === null || limit <= 0) throw new Error('no monthly quota');
  return {
    used,
    limit,
    remainingPercent: Math.max(0, Math.min(100, 100 - (used / limit) * 100)),
  };
}

function mimoParseDetail(data) {
  return {
    planName: typeof data.planName === 'string' && data.planName.trim() ? data.planName : null,
    planCode: typeof data.planCode === 'string' && data.planCode.trim() ? data.planCode : null,
    expired: !!data.expired,
  };
}

function mimoParseBalance(data) {
  const num = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && /^\d+(?:\.\d+)?$/.test(v.trim())) return Number(v);
    return null;
  };
  return {
    total: num(data.balance),
    cash: num(data.cashBalance),
    gift: num(data.giftBalance),
    currency:
      typeof data.currency === 'string' && /^[A-Za-z]{3}$/.test(data.currency.trim())
        ? data.currency.trim().toUpperCase()
        : null,
  };
}

// /usage/detail?year=&month= 返回当月按天明细（实测结构）：
//   tokenUsage: [["MM-DD", 输入, 输出, 总计, 缓存命中], ...]
//   requests:   [["MM-DD", 请求次数], ...]
// 另有 modelTokenUsage / modelRequests 按模型细分，本看板暂不使用。
function mimoParseUsageDetail(data) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const days = new Map();
  const touch = (key) => {
    if (!days.has(key)) {
      days.set(key, { date: key, input: null, output: null, total: null, cache: null, requests: null });
    }
    return days.get(key);
  };
  for (const row of Array.isArray(data.tokenUsage) ? data.tokenUsage : []) {
    if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
    const d = touch(row[0]);
    d.input = num(row[1]);
    d.output = num(row[2]);
    d.total = num(row[3]);
    d.cache = num(row[4]);
  }
  for (const row of Array.isArray(data.requests) ? data.requests : []) {
    if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
    touch(row[0]).requests = num(row[1]);
  }
  return [...days.values()];
}

// 明细里的日期键为本地时区下的 "MM-DD"，与请求头 x-timeZone 一致。
function mimoTodayKey(now) {
  return `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// POST /usage/detail/list 返回当月按天按模型的计费明细：
//   [{ date:"YYYY-MM-DD", model, currency:"CNY", consumedAmount:"0.535405", ... }]
// 仅按量计费部分才产生金额；套餐额度内的调用不计费、不出现在此列表。
function mimoParseBillList(data) {
  const rows = Array.isArray(data) ? data : [];
  const byDay = new Map();
  let currency = null;
  for (const r of rows) {
    if (!r || typeof r.date !== 'string') continue;
    const amount = Number(r.consumedAmount);
    if (!Number.isFinite(amount)) continue;
    byDay.set(r.date, (byDay.get(r.date) || 0) + amount);
    if (!currency && typeof r.currency === 'string' && r.currency.trim()) {
      currency = r.currency.trim().toUpperCase();
    }
  }
  return { byDay, currency };
}

function mimoDayKey(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// 单个接口独立容错：某个子接口失败不影响其它子接口的数据展示。
async function mimoRequest(url, name, cookie, timeoutMs, parse, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = mimoHeaders(cookie);
    const init = { headers, signal: ctrl.signal };
    if (opts.method) init.method = opts.method;
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }
    const r = await fetch(url, init);
    if (r.status >= 300 && r.status < 400) {
      return { ok: false, authExpired: true, error: `${name} 需要登录（Cookie 无效或已过期）` };
    }
    if (r.status === 401 || r.status === 403) {
      return { ok: false, authExpired: true, error: `${name} HTTP ${r.status}（Cookie 无效或已过期）` };
    }
    if (!r.ok) return { ok: false, error: `${name} HTTP ${r.status}` };

    let body = null;
    try { body = await r.json(); } catch (_) { return { ok: false, error: `${name} 响应无法解析` }; }

    const envErr = mimoEnvelopeError(body);
    if (envErr) {
      if (wbIsAuthError(envErr)) {
        return { ok: false, authExpired: true, error: `${name} ${envErr}（Cookie 无效或已过期）` };
      }
      return { ok: false, error: `${name} ${envErr}` };
    }

    try { return { ok: true, data: parse(body.data) }; }
    catch (_) { return { ok: false, error: `${name} 响应格式不符` }; }
  } catch (e) {
    const msg = e.name === 'AbortError' ? `超时（${timeoutMs}ms）` : e.message;
    return { ok: false, error: `${name} ${msg}` };
  } finally {
    clearTimeout(t);
  }
}

async function collectMimo({ cookie, timeoutMs = 10000 } = {}) {
  const norm = normalizeMimoCookie(cookie);
  if (!norm.ok) return { ok: false, error: norm.error };
  const cred = norm.cookie;

  const now = new Date();
  const dailyUrl = `${MIMO_USAGE_DETAIL_URL}?year=${now.getFullYear()}&month=${now.getMonth() + 1}`;
  const billUrl = norm.ph
    ? `${MIMO_BILL_LIST_URL}?api-platform_ph=${encodeURIComponent(norm.ph)}`
    : null;

  const [usage, detail, balance, daily, bill] = await Promise.all([
    mimoRequest(MIMO_USAGE_URL, 'usage', cred, timeoutMs, mimoParseUsage),
    mimoRequest(MIMO_DETAIL_URL, 'detail', cred, timeoutMs, mimoParseDetail),
    mimoRequest(MIMO_BALANCE_URL, 'balance', cred, timeoutMs, mimoParseBalance),
    mimoRequest(dailyUrl, 'usageDetail', cred, timeoutMs, mimoParseUsageDetail),
    billUrl
      ? mimoRequest(billUrl, 'bill', cred, timeoutMs, mimoParseBillList, {
          method: 'POST',
          body: { year: now.getFullYear(), month: now.getMonth() + 1 },
        })
      : Promise.resolve({ ok: false, error: 'bill Cookie 缺少 api-platform_ph，无法查询消费金额' }),
  ]);

  const results = [usage, detail, balance, daily, bill];
  const errors = results.filter((r) => !r.ok).map((r) => r.error);
  if (results.every((r) => !r.ok)) {
    return { ok: false, authExpired: results.some((r) => r.authExpired), error: errors[0] };
  }

  const plan = detail.ok
    ? { ...detail.data, expired: !!detail.data.expired }
    : null;
  const expired = plan ? plan.expired : false;
  // 只有 Token Plan 订阅账号才有月度额度；按量付费账号无此项，额度置空但仍返回余额。
  const quota = usage.ok && !expired ? usage.data : null;

  // 当月按天明细里取"今天"一行；今天无调用时各项为 0。
  let today = null;
  if (daily.ok) {
    const key = mimoTodayKey(now);
    const row = daily.data.find((x) => x.date === key) || null;
    const pick = (k) => (row && row[k] != null ? row[k] : 0);
    const input = pick('input');
    const cache = pick('cache');
    today = {
      date: key,
      requests: pick('requests'),
      input,
      output: pick('output'),
      total: pick('total'),
      cache,
      // 输入 Token 已含缓存命中部分，据此推算缓存未命中（仅在数据自洽时给出）。
      cacheMiss: input >= cache ? input - cache : null,
    };
  }

  // 今日消费：按量计费金额，取当天各模型求和（套餐额度内的调用不计费、不出现，故可能为 0）。
  let todayCost = null;
  let costCurrency = null;
  if (bill.ok) {
    todayCost = Math.round((bill.data.byDay.get(mimoDayKey(now)) || 0) * 1e6) / 1e6;
    costCurrency = bill.data.currency;
  }

  return {
    ok: true,
    plan,
    quota,
    balance: balance.ok ? balance.data : null,
    today,
    todayCost,
    costCurrency,
    errors,
  };
}

// ---- Qoder CN（qoder.com.cn 全功能版）：大模型 Credits 用量 ----
// 说明：Qoder 官方 OpenAPI 只面向 Teams/企业版（需组织 API Key），个人账号不适用。
// 个人账户用量只能读网页控制台的内部接口，鉴权用网页登录态 Cookie（会过期，
// 过期后需重新从浏览器复制）。接入思路参考开源实现 steipete/CodexBar（MIT）的
// Sources/CodexBarCore/Resources/Plugins/qoder.js，采用同一接口与请求头。
// 国际版为 qoder.com，中国大陆为 qoder.com.cn，两者接口路径相同，域不同。

const QODER_SITES = {
  cn: 'https://qoder.com.cn',
  intl: 'https://qoder.com',
};

// 只做基础整形：允许粘贴纯 Cookie 值、带 "Cookie:" 前缀的整行，
// 或从浏览器复制的多行请求头（自动抽取其中的 Cookie 行）。不裁剪字段，
// 因为 Qoder 会话可能依赖多个 cookie 组合。
function normalizeQoderCookie(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: '未配置 Qoder Cookie（config/qoder.json 的 cookie）' };
  }
  const text = raw.replace(/\r/g, '').trim();

  // 多行请求头/整段抓包：按行找 Cookie 头
  const lines = text.split('\n');
  let value = null;
  for (const line of lines) {
    const m = line.match(/^\s*(?:-H\s+)?['"]?\s*cookie\s*:\s*(.+?)\s*['"]?\s*$/i);
    if (m) { value = m[1]; break; }
  }
  if (value == null) {
    // 单行纯 Cookie 值，或单行 "Cookie: xxx"
    value = text.replace(/^cookie\s*:\s*/i, '').trim();
  }
  // 归一为一行，去掉可能的换行残留
  value = value.replace(/\n/g, ' ').trim();
  if (!value || !value.includes('=')) {
    return { ok: false, error: 'Cookie 格式不正确（应为 name=value 形式，或从浏览器复制完整 Cookie 头）' };
  }
  return { ok: true, cookie: value };
}

function qoderNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 单个额度块：{ usedValue, limitValue, remainingValue, usagePercentage, unit }
function qoderParseQuota(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const used = qoderNumber(summary.usedValue ?? summary.used_value) ?? 0;
  const total = qoderNumber(summary.limitValue ?? summary.limit_value) ?? 0;
  const rawRemain = summary.remainingValue ?? summary.remaining_value;
  const remaining = rawRemain == null ? Math.max(0, total - used) : (qoderNumber(rawRemain) ?? 0);
  return {
    used, total, remaining,
    provided: qoderNumber(summary.usagePercentage ?? summary.usage_percentage),
    unit: typeof summary.unit === 'string' ? summary.unit : null,
  };
}

function qoderParseReset(value) {
  if (typeof value === 'number') {
    const ms = value > 1e10 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

// 逐包展开「到期时间 + 未用积分」，供前端汇总“即将失效”的积分。
// 数据在 resource_package_quota.quota_detail[]：expires_at 为毫秒，remaining_value 为剩余。
function qoderPackExpiry(quotaDetail) {
  const out = [];
  for (const d of Array.isArray(quotaDetail) ? quotaDetail : []) {
    if (!d || typeof d !== 'object') continue;
    const remain = qoderNumber(d.remainingValue ?? d.remaining_value);
    if (!Number.isFinite(remain) || remain <= 0) continue;
    const raw = d.expiresAt ?? d.expires_at;
    if (raw == null || Number(raw) <= 0) continue; // 无到期时间的额度（如套餐额度）不计入
    const until = qoderParseReset(raw);
    if (!until) continue;
    out.push({ until, remain });
  }
  return out;
}

async function collectQoder({ cookie, site = 'cn', timeoutMs = 10000 } = {}) {
  const norm = normalizeQoderCookie(cookie);
  if (!norm.ok) return { ok: false, error: norm.error };

  const origin = QODER_SITES[site] || QODER_SITES.cn;
  const url = `${origin}/api/v2/me/usages/big_model_credits`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: {
        Cookie: norm.cookie,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Origin: origin,
        Referer: `${origin}/account/usage`,
        'X-Requested-With': 'XMLHttpRequest',
        'Bx-V': '2.5.35',
      },
      signal: ctrl.signal,
    });

    if (r.status === 401 || r.status === 403) {
      return { ok: false, authExpired: true, error: `HTTP ${r.status}（Qoder 登录态无效或已过期，请重新登录后复制 Cookie）` };
    }
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };

    let body = null;
    try { body = await r.json(); } catch (_) { return { ok: false, error: '响应无法解析为 JSON' }; }
    if (!body || typeof body !== 'object') return { ok: false, error: '接口未返回数据' };

    const base = qoderParseQuota((body.totalQuota || body.total_quota || {}).quotaSummary
      || (body.totalQuota || body.total_quota || {}).quota_summary);
    if (!base) return { ok: false, error: '响应缺少 totalQuota.quotaSummary 字段' };

    const sharedRaw = body.sharedQuota ?? body.shared_quota;
    const shared = sharedRaw
      ? qoderParseQuota((sharedRaw.quotaSummary || sharedRaw.quota_summary))
      : null;

    const used = base.used + (shared ? shared.used : 0);
    const total = base.total + (shared ? shared.total : 0);
    const remaining = base.remaining + (shared ? shared.remaining : 0);

    // 统一按 used/total 实算，保证进度条百分比与卡内「已用 x / y」文字同口径。
    // 接口自带的 usagePercentage 与实算值可能相差 1pp（平台取整方式不同），不直接上屏。
    const usedPercent = total > 0 ? (used / total) * 100 : 100;
    const round2 = (n) => Math.round(n * 100) / 100;
    // 资源包明细（含到期时间）用于「即将到期积分」提示。
    const pkgRaw = body.resourcePackageQuota ?? body.resource_package_quota;

    return {
      ok: true,
      site,
      origin,
      unit: base.unit || (shared && shared.unit) || 'credits',
      used: round2(used),
      total: round2(total),
      remaining: round2(remaining),
      usedPercent: round2(Math.max(0, Math.min(100, usedPercent))),
      remainingPercent: round2(Math.max(0, Math.min(100, 100 - usedPercent))),
      hasShared: !!shared,
      resetsAt: qoderParseReset(body.nextResetAt ?? body.next_reset_at),
      // 各资源包的到期时间与剩余积分，供前端汇总“即将失效”的积分。
      packExpiry: qoderPackExpiry(pkgRaw && (pkgRaw.quotaDetail || pkgRaw.quota_detail)),
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `超时（${timeoutMs}ms）` : e.message };
  } finally {
    clearTimeout(t);
  }
}

// ---- MiniMax：开放平台按量付费账户余额（官方公开接口）----
// 说明：与其它平台不同，MiniMax 余额/用量走官方公开 API，只需 API Key（Bearer），
// 无需抓取网页登录态。按量付费账号查 /account/query_balance；
// Token Plan 订阅 Key（sk- 非 sk-api- 前缀）走 /v1/token_plan/remains，本采集器暂不覆盖。
const MM_REGION_BASE = {
  cn: 'https://api.minimaxi.com',
  intl: 'https://api.minimax.io',
};

// 官方返回的金额是字符串（如 "98.00001"），非法值返回 null 交由前端显示占位。
function mmMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
}

async function collectMinimax({ apiKey, region = 'cn', baseUrl, timeoutMs = 10000 } = {}) {
  if (!apiKey) return { ok: false, error: '未配置 MiniMax API Key（config/minimax.json）' };
  const root = (baseUrl || MM_REGION_BASE[region] || MM_REGION_BASE.cn).replace(/\/+$/, '');

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${root}/account/query_balance`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    const text = await r.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (_) {}

    // 鉴权/参数等错误可能返回 HTTP 400/200，统一以 base_resp.status_code 判定成功与否。
    const code = data?.base_resp?.status_code;
    if (code !== undefined && code !== 0) {
      return { ok: false, error: `接口错误 ${code}：${data?.base_resp?.status_msg || ''}`.trim() };
    }
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}${text ? `：${text.slice(0, 200)}` : ''}` };
    if (!data) return { ok: false, error: '响应不是合法 JSON' };

    return {
      ok: true,
      region,
      currency: region === 'intl' ? 'USD' : 'CNY',
      balance: {
        available: mmMoney(data.available_amount),
        cash: mmMoney(data.cash_balance),
        voucher: mmMoney(data.voucher_balance),
        credit: mmMoney(data.credit_balance),
        owed: mmMoney(data.owed_amount),
      },
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? `超时（${timeoutMs}ms）` : e.message };
  } finally {
    clearTimeout(t);
  }
}

module.exports = {
  collectCodex,
  collectDeepseek,
  collectDeepseekUsage,
  collectWorkbuddy,
  refreshWorkbuddyToken,
  collectTrae,
  collectMimo,
  collectQoder,
  collectMinimax,
};