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

const CANDIDATES = [3000, 5700, 6700, 8080, 18080, 18700];

function logLine(dataDir, entry) {
  try { appendJsonl(path.join(dataDir, 'qq.log'), Object.assign({ ts: nowIso() }, entry)); } catch (e) {}
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
  const tokens = [];
  if (q.token) tokens.push(q.token);
  tokens.push('');
  for (const port of CANDIDATES) {
    const gw = 'http://127.0.0.1:' + port;
    for (const tk of tokens) {
      const r = await probe(gw, tk);
      if (r.ok) {
        logLine(dataDir, { dir: 'discover', ok: true, peer: gw, digest: r.nickname });
        return {
          found: true, gateway: gw, token: tk, tokenMasked: mask(tk),
          selfId: r.selfId, nickname: r.nickname || 'QQ 桥接'
        };
      }
    }
  }
  logLine(dataDir, { dir: 'discover', ok: false, reason: 'not found' });
  return {
    found: false,
    hints: [
      '没在本机找到 QQ 桥接（常见端口都试过了）',
      '装一个 OneBot 类网关（SnowLuma / NapCat 之类），启动它的 HTTP 服务',
      '装好点「重新检测」；也可以在「高级」里手动填地址和令牌'
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
  const r = await probe(gateway, token || '');
  if (!r.ok) {
    let why = r.reason;
    if (/401|403/.test(r.reason)) why = '令牌不对';
    else if (/timeout|fetch|ECONN|connect/i.test(r.reason)) why = '端口没开或连不上';
    logLine(dataDir, { dir: 'connect', ok: false, reason: why });
    return { ok: false, error: '连不上：' + why };
  }
  const saved = writeQQ(cfgFile, (q) => Object.assign(q, {
    enabled: true, gateway, token: token || '', self_id: r.selfId || q.self_id || ''
  }));
  if (cfg) cfg.qq = saved;
  logLine(dataDir, { dir: 'connect', ok: true, peer: r.nickname, digest: r.selfId });
  return { ok: true, enabled: true, nickname: r.nickname || nickname || 'QQ 桥接', selfId: r.selfId || selfId, gateway };
}

function disconnect(opts) {
  const { cfg, dataDir, cfgFile } = opts;
  const saved = writeQQ(cfgFile, (q) => Object.assign(q, { enabled: false }));
  if (cfg) cfg.qq = saved;
  logLine(dataDir, { dir: 'disconnect', ok: true });
  return { ok: true, enabled: false };
}

module.exports = { discover, connect, disconnect, probe, CANDIDATES };
