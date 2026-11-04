'use strict';
/*
 * QQ 一键连接：自动发现本机 OneBot 网关 + 一键启用 + 断连
 *
 * - 扫常见 OneBot HTTP 端口（3000/5700/6700/8080/18080/18700），探 /get_login_info
 *   （先试配置里的 token，再试不带 token）；
 * - 成功才写 config.json 的 qq.enabled=true（默认始终关闭，必须用户点了才开）；
 * - 断连就是把 qq.enabled 改回 false。
 * 只读别人的桥接配置（如果存在），绝不写。
 */
const fs = require('fs');
const path = require('path');
const { readCfg } = require('./adapter');
const { appendJsonl, nowIso } = require('../util');

const CANDIDATES = [3000, 3100, 5700, 6700, 8080, 18080, 18700, 3001, 3002];

function lastFile(dataDir) { return path.join(dataDir, 'qq-last.json'); }

function readLast(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(lastFile(dataDir), 'utf8'));
    return (j && j.gateway) ? j : null;
  } catch (e) { return null; }
}

function saveLast(dataDir, gateway, token) {
  try { fs.writeFileSync(lastFile(dataDir), JSON.stringify({ gateway, token, at: nowIso() }, null, 2), 'utf8'); } catch (e) {}
}

function logLine(dataDir, entry) {
  try { appendJsonl(path.join(dataDir, 'qq.log'), Object.assign({ ts: nowIso() }, entry)); } catch (e) {}
}

/*
 * 只读本机网关自己的配置，把端口和 accessToken 捞出来。
 * SnowLuma 的 OneBot 配置是按账号命名的（onebot_<uin>.json），
 * 而且 HTTP 和 WS 是两个不同的 token —— 收消息要用 WS 那个、发消息要用 HTTP 那个，
 * 让用户自己抄根本分不清，所以这里直接按 role 分好。
 * 只读不写，读不到就算了。
 */
function localGatewaySecrets() {
  const out = [];
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (!home) return out;
  const dirs = [
    path.join(home, 'SnowLuma', 'config'),
    path.join(home, 'snowluma', 'config'),
    path.join(home, 'AppData', 'Local', 'SnowLuma', 'config'),
    // 常见的「我把它解压到 D 盘/别处」的位置
    'D:\\SnowLuma\\config',
    'D:\\snowluma\\config',
    'C:\\SnowLuma\\config'
  ];
  // 大多数人不会乖乖放在用户目录，直接解压到桌面/下载里——
  // 往这两处再探一层，能找到就不用手抄令牌了
  for (const base of ['Desktop', 'Downloads', 'Documents']) {
    let subs = [];
    try { subs = fs.readdirSync(path.join(home, base)); } catch (e) { continue; }
    for (const sub of subs) {
      dirs.push(path.join(home, base, sub, 'config'));
      dirs.push(path.join(home, base, sub, 'SnowLuma', 'config'));
    }
  }
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /^onebot.*\.json$/i.test(f)); } catch (e) { continue; }
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const nets = (j && j.networks) || {};
        const http = (nets.httpServers || [])[0];
        const ws = (nets.wsServers || [])[0];
        if (http && http.port) out.push({ role: 'http', port: Number(http.port), token: String(http.accessToken || '') });
        if (ws && ws.port) out.push({ role: 'ws', port: Number(ws.port), token: String(ws.accessToken || '') });
      } catch (e) { /* 坏文件跳过 */ }
    }
  }
  return out;
}

function mask(t) {
  t = String(t || '');
  if (!t) return '';
  return t.length <= 4 ? '****' : t.slice(0, 3) + '****';
}

async function probe(gateway, token) {
  try {
    const h = { 'content-type': 'application/json' };
    if (token) h.authorization = 'Bearer ' + token;
    const r = await fetch(String(gateway).replace(/\/+$/, '') + '/get_login_info', { headers: h, signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { ok: false, reason: 'HTTP ' + r.status };
    const j = await r.json().catch(() => null);
    if (!j || typeof j !== 'object') return { ok: false, reason: '不是 OneBot 响应' };
    const data = j.data || j;
    if (!data || (data.user_id === undefined && !data.nickname)) return { ok: false, reason: '不是 OneBot 实现' };
    return { ok: true, nickname: String(data.nickname || ''), selfId: String(data.user_id || '') };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function writeQQ(cfgFile, mutate) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) { cur = {}; }
  const base = Object.assign({ enabled: false, gateway: '', token: '', allow: [], groups: [], self_id: '' }, cur.qq || {});
  cur.qq = mutate(base);
  fs.writeFileSync(cfgFile, JSON.stringify(cur, null, 2), 'utf8');
  return cur.qq;
}

async function discover(cfg, dataDir) {
  const q = readCfg(cfg);
  const locals = localGatewaySecrets();
  const tokens = [];
  if (q.token) tokens.push(q.token);
  // 本机网关配置里的令牌（SnowLuma 等），解决「新人有网关但没令牌」的 401
  for (const l of locals) if (tokens.indexOf(l.token) < 0) tokens.push(l.token);
  tokens.push('');
  // 上次连通过的那一个先试：一次连通之后就不用每次全扫一遍
  const last = readLast(dataDir);
  const ports = [];
  if (last && last.gateway) {
    const m = String(last.gateway).match(/:(\d+)\/?$/);
    if (m) ports.push(Number(m[1]));
    if (last.token && tokens.indexOf(last.token) < 0) tokens.unshift(last.token);
  }
  // 本机网关配置里写着的端口也优先试
  for (const l of locals) if (ports.indexOf(l.port) < 0) ports.push(l.port);
  for (const p of CANDIDATES) if (ports.indexOf(p) < 0) ports.push(p);
  const sawUnauthorized = [];
  for (const port of ports) {
    const gw = 'http://127.0.0.1:' + port;
    for (const tk of tokens) {
      const r = await probe(gw, tk);
      if (r.ok) {
        saveLast(dataDir, gw, tk);
        logLine(dataDir, { dir: 'discover', ok: true, peer: gw, digest: r.nickname });
        return {
          found: true, gateway: gw, token: tk, tokenMasked: mask(tk),
          selfId: r.selfId, nickname: r.nickname || 'QQ 桥接'
        };
      }
      if (String(r.reason || '').indexOf('401') >= 0) sawUnauthorized.push(gw);
    }
  }
  logLine(dataDir, { dir: 'discover', ok: false, reason: sawUnauthorized.length ? 'need token' : 'not found' });
  if (sawUnauthorized.length) {
    return {
      found: false,
      needToken: true,
      gateway: sawUnauthorized[0],
      hints: [
        '找到了本机 QQ 桥接（' + sawUnauthorized[0] + '），但它要令牌，没令牌不让连',
        '去网关自己的设置里复制 accessToken（SnowLuma 是 OneBot HTTP 那栏），粘到下面的「令牌」框',
        '粘好再点一次「自动找 QQ 桥接」就能连上'
      ]
    };
  }
  return {
    found: false,
    hints: [
      '没在本机找到能用的 QQ 桥接（常见端口都试过了：' + CANDIDATES.join(' / ') + '）',
      '它得是 OneBot HTTP 形态（NapCat、LLOneBot 这类），把 HTTP 服务开起来再点「重新检测」',
      'SnowLuma 只有一个自有接口的话连不上——在它里面开 HTTP 服务，或换一个 OneBot 实现',
      '急着连的话，在「高级」里手填地址（例如 http://127.0.0.1:3000）和令牌'
    ]
  };
}

async function connect(opts) {
  const { cfg, dataDir, cfgFile } = opts;
  let gateway = opts.gateway;
  let token = opts.token;
  let selfId = '';
  let nickname = '';
  if (!gateway) {
    const d = await discover(cfg, dataDir);
    if (!d.found) return { ok: false, error: '没找到可用的 QQ 桥接', hints: d.hints };
    gateway = d.gateway;
    token = d.token;
    selfId = d.selfId;
    nickname = d.nickname;
  }
  // 用户直接填了 ws:// 地址：不用探测 HTTP，存下来让 WS 桥自己去连。
  // 收和发都走这一条 WS，只需要一个令牌。
  if (/^wss?:\/\//i.test(String(gateway || ''))) {
    const savedWs = writeQQ(cfgFile, (q) => Object.assign(q, {
      enabled: true,
      kind: 'onebot-ws',
      wsUrl: String(gateway).replace(/\/+$/, ''),
      accessToken: token || q.accessToken || '',
      token: token || q.token || '',
      httpUrl: '',
      gateway: '',
      self_id: q.self_id || ''
    }));
    if (cfg) cfg.qq = savedWs;
    logLine(dataDir, { dir: 'connect', ok: true, peer: 'ws', mode: 'onebot-ws' });
    const emptyWs = !((savedWs.allow || []).length);
    return {
      ok: true, enabled: true, kind: 'onebot-ws', nickname: 'WS 直连',
      selfId: savedWs.self_id || '', gateway,
      needAllow: emptyWs,
      note: emptyWs ? '白名单还是空的：去 QQ 里发一句，再把你自己的 QQ 号填进「允许私聊的QQ号」，她才会回。' : ''
    };
  }
  const r = await probe(gateway, token || '');
  if (!r.ok) {
    let why = r.reason;
    if (/401|403/.test(r.reason)) why = '令牌不对';
    else if (/timeout|fetch|ECONN|connect/i.test(r.reason)) why = '端口没开或连不上';
    logLine(dataDir, { dir: 'connect', ok: false, reason: why });
    return { ok: false, error: '连不上：' + why };
  }
  // 本机要是 SnowLuma 那种 HTTP/WS 双端口的网关，直接帮他配成：
  // 收消息走 WS（用 WS 的 token）、发消息走 HTTP（用 HTTP 的 token）。
  // 这层分不清就是新手最大的坑，用户不需要理解它。
  const locals = localGatewaySecrets();
  const httpOne = locals.filter((l) => l.role === 'http')[0];
  const wsOne = locals.filter((l) => l.role === 'ws')[0];
  const gatewayPort = Number((String(gateway).match(/:(\d+)\/?$/) || [])[1] || 0);
  const useWs = !!(httpOne && wsOne && gatewayPort && httpOne.port === gatewayPort);
  const saved = writeQQ(cfgFile, (q) => Object.assign(q, useWs ? {
    enabled: true,
    kind: 'onebot-ws',
    wsUrl: 'ws://127.0.0.1:' + wsOne.port,
    httpUrl: 'http://127.0.0.1:' + httpOne.port,
    // WS 连的是 WS 那个服务，令牌必须用 WS 的（探测用的是 HTTP 那个，不能拿来连 WS）
    accessToken: wsOne.token || token,
    httpAccessToken: httpOne.token,
    gateway: 'http://127.0.0.1:' + httpOne.port,
    token: token || '',
    self_id: r.selfId || q.self_id || ''
  } : {
    enabled: true, gateway, token: token || '', self_id: r.selfId || q.self_id || ''
  }));
  saveLast(dataDir, gateway, token || '');
  if (cfg) cfg.qq = saved;
  const allowEmpty = !((saved.allow || []).length);
  logLine(dataDir, { dir: 'connect', ok: true, peer: r.nickname, digest: r.selfId, mode: saved.kind || 'onebot-http' });
  return {
    ok: true, enabled: true,
    kind: saved.kind || 'onebot-http',
    nickname: r.nickname || nickname || 'QQ 桥接',
    selfId: r.selfId || selfId,
    gateway,
    needAllow: allowEmpty,
    note: allowEmpty ? '白名单还是空的：去 QQ 里用你自己的号给小号发一句，然后在「允许私聊的QQ号」里填上你自己的号，她才会回。' : ''
  };
}

function disconnect(opts) {
  const { cfg, dataDir, cfgFile } = opts;
  const saved = writeQQ(cfgFile, (q) => Object.assign(q, { enabled: false }));
  if (cfg) cfg.qq = saved;
  logLine(dataDir, { dir: 'disconnect', ok: true });
  return { ok: true, enabled: false };
}

module.exports = { discover, connect, disconnect, probe, CANDIDATES };
