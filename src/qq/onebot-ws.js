'use strict';
/*
 * OneBot WS 直连（它讲 OneBot v11 WebSocket，不是 HTTP 回调）
 *
 * 软件自带的 QQ 适配层只认「网关 HTTP 推事件」：OneBot HTTP 形态（NapCat / LLOneBot）
 * 用 /api/qq/incoming 收消息。SnowLuma 是 WS 推事件，所以这里补一个 WS 监听：
 *   连 ws://127.0.0.1:3001?access_token=...
 *   收到 message 事件 → 交给 qq.incoming（白名单 / @ / 红线都在那层）
 *   回复照旧走 qq.send（HTTP 动作，http://127.0.0.1:3000）
 *
 * 默认 dryRun：只记录收到什么，不自动回复（避免和 DSH 自带 QQ 桥接抢话）。
 */
const fs = require('fs');
const path = require('path');
const { appendJsonl, nowIso, truncate } = require('../util');

class OneBotWsBridge {
  constructor(opts) {
    const o = opts || {};
    this.wsUrl = String(o.wsUrl || 'ws://127.0.0.1:3001').replace(/\/+$/, '');
    this.token = String(o.token || '');
    this.onEvent = typeof o.onEvent === 'function' ? o.onEvent : null;
    this.logFile = o.logFile || '';
    this.dryRun = !!o.dryRun;
    this.ws = null;
    this.closed = false;
    this.retry = 0;
    this.timer = null;
    this.lastNote = '';
  }

  log(o) {
    const row = Object.assign({ ts: nowIso(), at: 'snowluma' }, o || {});
    try { if (this.logFile) appendJsonl(this.logFile, row); } catch (e) {}
    return row;
  }

  start() {
    if (this.closed) return;
    const url = this.wsUrl + (this.token ? ('?access_token=' + encodeURIComponent(this.token)) : '');
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.scheduleRetry('建连失败：' + e.message);
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.retry = 0;
      this.lastNote = 'connected';
      this.log({ ok: true, event: 'open', url: this.wsUrl, dryRun: this.dryRun });
    });
    ws.addEventListener('message', (ev) => {
      let data = null;
      try { data = JSON.parse(String(ev.data)); } catch (e) { return; }
      // 只管消息事件；自己发的、心跳之类直接放过
      if (!data || data.post_type !== 'message') return;
      this.log({
        dir: 'in', ok: true, kind: data.message_type, peer: String(data.group_id || data.user_id || ''),
        sender: data.sender && (data.sender.card || data.sender.nickname) || '',
        len: String(data.raw_message || '').length,
        digest: truncate(String(data.raw_message || ''), 40),
        dryRun: this.dryRun
      });
      if (this.dryRun) return;
      if (this.onEvent) {
        Promise.resolve(this.onEvent(data)).catch((e) => this.log({ ok: false, event: 'handle', error: String(e.message || e) }));
      }
    });
    ws.addEventListener('close', (ev) => {
      this.ws = null;
      this.log({ ok: false, event: 'close', code: ev && ev.code, reason: ev && ev.reason });
      this.scheduleRetry('连接断了');
    });
    ws.addEventListener('error', () => {
      this.log({ ok: false, event: 'error' });
    });
  }

  scheduleRetry(reason) {
    if (this.closed) return;
    this.lastNote = reason;
    this.retry = Math.min(this.retry + 1, 20);
    const ms = Math.min(30000, 1000 * Math.pow(2, Math.min(this.retry, 5)));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.start(), ms);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try { if (this.ws) this.ws.close(); } catch (e) {}
    this.ws = null;
  }
}

module.exports = { OneBotWsBridge };
