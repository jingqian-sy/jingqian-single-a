'use strict';
/*
 * 自由时间：她闲着的时候自己找你说话。
 *
 * 怎么判断「该开口了」：
 *   会话闲置够久了（默认 30 分钟），今天还没说到次数上限（默认 5 次），
 *   而且不是在免打扰时段（默认 23:30 ~ 08:00）。
 *
 * 说什么不是插件决定的：插件只负责「什么时候」。那句话交给主程序生成，
 * 用的是同一个人格、同一份记忆，和正常聊天一模一样。
 *
 * 说完写进会话历史，桌面窗口那边轮询就能看到；接了 QQ 的话再从网关发一份。
 * 线程里会自己记数，写在 data/settings.json 和 data/counter.json，重装插件不丢。
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  enabled: true,
  idleMinutes: 30,      // 多久没动静才轮到她开口
  maxPerDay: 5,         // 一天最多几次，别烦人
  quietStart: '23:30',  // 这段区间不打扰
  quietEnd: '08:00',
  targets: ['desktop', 'qq']  // 桌面窗口说一句；接了 QQ 也发过去
};

module.exports = function (ctx) {
  const setFile = path.join(ctx.dataDir, 'settings.json');
  const cntFile = path.join(ctx.dataDir, 'counter.json');

  const readSet = () => {
    try { return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(setFile, 'utf8'))); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  };
  const st0 = readSet();
  if (!fs.existsSync(setFile)) fs.writeFileSync(setFile, JSON.stringify(st0, null, 2), 'utf8');
  let st = st0;

  const dayKey = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  const readCount = () => {
    try {
      const c = JSON.parse(fs.readFileSync(cntFile, 'utf8'));
      return c && c.day === dayKey() ? c : { day: dayKey(), n: 0, last: '' };
    } catch (e) { return { day: dayKey(), n: 0, last: '' }; }
  };
  const writeCount = (c) => fs.writeFileSync(cntFile, JSON.stringify(c, null, 2), 'utf8');

  const toMin = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  };
  const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const inQuiet = () => {
    const a = toMin(st.quietStart), b = toMin(st.quietEnd), n = nowMin();
    if (a < 0 || b < 0 || a === b) return false;
    return a < b ? (n >= a && n < b) : (n >= a || n < b);
  };

  let busy = false;
  const lastNote = { at: '', result: '还没试过' };

  async function check() {
    // 每轮重读一次设置：改了 settings.json 不用重启
    st = readSet();
    if (busy || !st.enabled) return;
    if (inQuiet()) return;
    const c = readCount();
    if (c.n >= Number(st.maxPerDay) || Number(st.maxPerDay) <= 0) return;
    // 会话最后动静到现在隔了多久（分钟）
    const idle = ctx.proactive.idleMinutes('desktop');
    // 最短 5 分钟：写 0 会一分钟一句，太吵也太费
    const needIdle = Math.max(5, Number.isFinite(Number(st.idleMinutes)) ? Number(st.idleMinutes) : 30);
    if (idle < 0 || idle < needIdle) return;
    busy = true;
    try {
      const wantQQ = st.targets.indexOf('qq') >= 0;
      const r = await ctx.proactive.say({ sessionId: 'desktop', idleMinutes: idle, target: wantQQ ? 'qq' : '' });
      if (r && r.spoke) {
        c.n += 1;
        c.last = String(r.reply || '').slice(0, 60);
        writeCount(c);
        lastNote.at = new Date().toISOString();
        lastNote.result = '说了：' + String(r.reply || '').slice(0, 40) + (r.qqError ? '（QQ 没发出去：' + r.qqError + '）' : '');
      } else {
        lastNote.at = new Date().toISOString();
        lastNote.result = '这轮不想说（模型回了 SILENT）';
      }
    } catch (e) {
      lastNote.at = new Date().toISOString();
      lastNote.result = '出错了：' + e.message;
      ctx.log('开口失败：' + e.message);
    } finally {
      busy = false;
    }
  }

  // 一分钟看一次：便宜，且不会因为睡过去错过时间窗
  ctx.tick(check, 60000);

  // GET /api/plugin/free-time/status —— 看看现在什么设置、今天说了几次
  ctx.registerRoute('GET', 'status', function () {
    const c = readCount();
    return {
      enabled: st.enabled,
      idleMinutes: st.idleMinutes,
      maxPerDay: st.maxPerDay,
      quiet: st.quietStart + '~' + st.quietEnd,
      targets: st.targets,
      nowIdleMinutes: ctx.proactive.idleMinutes('desktop'),
      todayCount: c.n,
      todayLast: c.last,
      lastTick: lastNote.at,
      lastResult: lastNote.result
    };
  });

  ctx.log('自由时间插件起来了：闲置 ' + st.idleMinutes + ' 分钟开口，一天最多 ' + st.maxPerDay + ' 次');
  return { title: '自由时间', config: st };
};
