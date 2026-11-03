'use strict';
/*
 * QQ 适配层（可选，默认关闭）
 *
 * 入方向：外部桥接（OneBot HTTP 那类）把消息 POST 到 /api/qq/incoming，
 *         白名单 + @/点名校验 → 调本机 core.chat → 返回 reply 给桥接去发。
 * 出方向：POST /api/qq/send {to, text, group?} → 调网关 /send_private_msg 或 /send_group_msg。
 *
 * 安全边界：
 *   - qq.enabled 不为 true 一律不处理（默认 false）；
 *   - 私聊要 qq.allow 里有这个 QQ 号；群聊要 qq.groups 里有这个群，且必须 @ 她/点名；
 *   - 群里出现「删/格式化/授权」这类词，直接回固定话术，不进模型；
 *   - 每条都写 data/qq.log，只记摘要（不记完整长文本）。
 */
const fs = require('fs');
const path = require('path');
const { appendJsonl, nowIso, truncate } = require('../util');

const DANGER = /删|格式化|格盘|授权|提权|管理员权限|改密码/;
const DANGER_REPLY = '这个操作风险太大，我不在 QQ 里做。你在电脑上自己确认一下，别在聊天窗口里让我动手。';

function readCfg(cfg) {
  const q = (cfg && cfg.qq) || {};
  return {
    enabled: !!q.enabled,
    gateway: String(q.gateway || '').replace(/\/+$/, ''),
    token: String(q.token || q.accessToken || ''),
    allow: (q.allow || []).map(String),
    groups: (q.groups || []).map(String),
    selfId: String(q.self_id || q.selfId || '')
  };
}

function logLine(dataDir, entry) {
  try {
    appendJsonl(path.join(dataDir, 'qq.log'), Object.assign({ ts: nowIso() }, entry));
  } catch (e) { /* 日志写不进去不拖垮主流程 */ }
}

function mention(text, q) {
  const t = String(text || '');
  if (/\[CQ:at,qq=\d+\]/.test(t)) return true;
  if (q.selfId && t.indexOf('[CQ:at,qq=' + q.selfId + ']') >= 0) return true;
  return /^鲸倩|^小鲸|^在吗鲸倩/.test(t.replace(/^\s+/, '')) || /^@鲸倩/.test(t);
}

function clean(text) {
  return String(text || '').replace(/\[CQ:[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
}

function judge(ev, q) {
  if (!q.enabled) return { handle: false, reason: 'qq disabled（默认关，要手动开）' };
  if (!ev || ev.post_type !== 'message') return { handle: false, reason: '不是消息事件' };
  const kind = ev.message_type;
  if (kind === 'private') {
    if (!q.allow.includes(String(ev.user_id))) return { handle: false, reason: '私聊不在白名单' };
    return { handle: true, kind: 'private', session: 'qq-p' + ev.user_id, peer: String(ev.user_id) };
  }
  if (kind === 'group') {
    if (!q.groups.includes(String(ev.group_id))) return { handle: false, reason: '群不在白名单' };
    const text = clean(ev.raw_message || ev.message);
    if (!mention(ev.raw_message || ev.message, q)) return { handle: false, reason: '群里没 @/点名，不刷屏' };
    return { handle: true, kind: 'group', session: 'qq-g' + ev.group_id, peer: String(ev.group_id), text: text };
  }
  return { handle: false, reason: '不支持的消息类型' };
}

async function incoming(opts) {
  const { cfg, her, dataDir, ev } = opts;
  const q = readCfg(cfg);
  const d = judge(ev, q);
  if (!d.handle) {
    logLine(dataDir, { dir: 'in', ok: false, reason: d.reason, peer: (ev && (ev.user_id || ev.group_id)) || '' });
    return { ok: false, ignored: true, reason: d.reason };
  }
  const raw = String((ev && (ev.raw_message || ev.message)) || '');
  const text = d.text || clean(raw);
  logLine(dataDir, { dir: 'in', ok: true, kind: d.kind, peer: d.peer, len: text.length, digest: truncate(text, 40) });
  if (d.kind === 'group' && DANGER.test(text)) {
    logLine(dataDir, { dir: 'out', ok: true, kind: d.kind, peer: d.peer, fixed: 'danger' });
    return { ok: true, reply: DANGER_REPLY, fixed: true };
  }
  const sender = (ev && ev.sender) || {};
  const speakerName = String(sender.card || sender.nickname || sender.user_id || '').trim();
  const speaker = d.kind === 'group' && speakerName
    ? { id: String((ev && ev.user_id) || ''), name: speakerName.slice(0, 40), owner: q.allow.includes(String(ev && ev.user_id)) }
    : undefined;
  const r = await her.chat(text, { sessionId: d.session, speaker: speaker, entry: 'qq' });
  logLine(dataDir, { dir: 'out', ok: true, kind: d.kind, peer: d.peer, len: String(r.reply || '').length });
  return { ok: true, reply: r.reply, kind: d.kind, peer: d.peer };
}

async function send(opts) {
  const { cfg, dataDir, to, text, group } = opts;
  const q = readCfg(cfg);
  if (!q.enabled) return { ok: false, error: 'qq disabled（默认关）' };
  if (!q.gateway) return { ok: false, error: '没配 qq.gateway' };
  const isGroup = !!group;
  const url = q.gateway + (isGroup ? '/send_group_msg' : '/send_private_msg');
  const body = isGroup ? { group_id: Number(to), message: String(text) } : { user_id: Number(to), message: String(text) };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, q.token ? { authorization: 'Bearer ' + q.token } : {}),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    const j = await r.json().catch(() => ({}));
    logLine(dataDir, { dir: 'out', ok: r.ok, kind: isGroup ? 'group' : 'private', peer: String(to), len: String(text).length, digest: truncate(String(text), 40) });
    return { ok: r.ok, status: r.status, result: j };
  } catch (e) {
    logLine(dataDir, { dir: 'out', ok: false, kind: isGroup ? 'group' : 'private', peer: String(to), error: e.message });
    return { ok: false, error: e.message };
  }
}

module.exports = { incoming, send, judge, mention, clean, readCfg, DANGER, DANGER_REPLY };
