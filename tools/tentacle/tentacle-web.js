'use strict';
/*
 * 触手 · 浏览器适配器（不做截图猜坐标，直接走应用自己的接口）
 * 原理：用 Edge/Chrome 的 DevTools 协议（CDP）连进去，像人一样"看懂"页面结构再动手。
 *
 * 用法：
 *   node tentacle-web.js start [端口]        起一个可调试的 Edge（独立配置，不影响你原来的浏览器）
 *   node tentacle-web.js open <url>          在受控窗口里打开网址
 *   node tentacle-web.js text                把当前页面可见文字取出来（相当于"看"
 *   node tentacle-web.js click "<文字>"       按可见文字点（按钮/链接/任意可点元素）
 *   node tentacle-web.js type "<选择器>" "<文字>"  往输入框输入
 *   node tentacle-web.js eval "<js>"         直接注入一段 JS 执行
 *
 * 这条线比截图稳：页面改版不会瞎点，也不会点到看不见的地方。
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const HOME = process.env.JINGQIAN_TENTACLE_HOME || __dirname;
const STATE = path.join(HOME, 'state');
const LOG = path.join(STATE, 'tentacle-web.log');
const PROFILE = path.join(STATE, 'edge-profile');
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];

fs.mkdirSync(STATE, { recursive: true });
function log(s) { try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + s + '\n', 'utf8'); } catch (e) {} }

function portArg() {
  const i = process.argv.indexOf('--port');
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  if (process.argv[2] === 'start' && process.argv[3] && /^\\d+$/.test(process.argv[3])) return Number(process.argv[3]);
  return 9333;
}
const PORT = portArg();

function edgePath() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Edge/Chrome');
}

async function listTargets() {
  const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
  if (!r.ok) throw new Error('CDP 没响应（先 node tentacle-web.js start）');
  return await r.json();
}

async function connect() {
  const targets = await listTargets();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的页面，先 open 一个网址');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(new Error('ws 连不上'));
  });
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
    }
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('CDP 超时：' + method)); } }, 30000);
  });
  return { ws, send };
}

async function evaluate(send, js) {
  const r = await send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'JS 执行出错');
  return r.result && r.result.value;
}

async function main() {
  const cmd = process.argv[2];
  const a = process.argv.slice(3).filter((x) => !x.startsWith('--'));

  if (cmd === 'start') {
    const port = Number(a[0]) || 9333;
    fs.mkdirSync(PROFILE, { recursive: true });
    const child = spawn(edgePath(), [
      '--remote-debugging-port=' + port,
      '--user-data-dir=' + PROFILE,
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized',
      'about:blank'
    ], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    await new Promise((r) => setTimeout(r, 2500));
    const t = await listTargets().catch(() => []);
    console.log('受控浏览器已起，端口 ' + port + '，页面数 ' + t.length);
    log('start port=' + port);
    return;
  }

  if (cmd === 'open') {
    const { send, ws } = await connect();
    await send('Page.enable');
    await send('Page.navigate', { url: a[0] });
    await new Promise((r) => setTimeout(r, 1200));
    const title = await evaluate(send, 'document.title');
    console.log('打开了：' + title + '（' + a[0] + '）');
    log('open ' + a[0] + ' → ' + title);
    ws.close();
    return;
  }

  if (cmd === 'shot') {
    const out = a[0] || ('D:/鲸倩核心/state/shots/web-' + Date.now() + '.png');
    const { send, ws } = await connect();
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
    console.log(out);
    log('web 截图 ' + out);
    ws.close();
    return;
  }

  if (cmd === 'text') {
    const { send, ws } = await connect();
    const txt = await evaluate(send, 'document.body ? document.body.innerText.slice(0,4000) : ""');
    console.log(String(txt || '').trim());
    log('text ' + String(txt || '').length + ' 字');
    ws.close();
    return;
  }

  if (cmd === 'click') {
    const label = a.join(' ');
    const { send, ws } = await connect();
    const js = `(() => {
      const want = ${JSON.stringify(label)};
      const primary = [...document.querySelectorAll('button,a,[role=button],input[type=button],input[type=submit],label,li')];
      const fallback = [...document.querySelectorAll('div,span')];
      const all = primary.length ? primary.concat(fallback) : fallback;
      const hit = all.find(e => (e.innerText||e.value||'').trim().includes(want) && e.offsetParent !== null);
      if (!hit) return 'NOT_FOUND';
      hit.scrollIntoView({block:'center'});
      hit.click();
      return 'OK:' + ((hit.innerText||hit.value||'').trim().slice(0,30));
    })()`;
    const r = await evaluate(send, js);
    if (r === 'NOT_FOUND') { console.log('页面上没找到「' + label + '」'); log('click 未命中 ' + label); ws.close(); process.exit(2); }
    console.log('点了：' + r);
    log('click ' + label + ' → ' + r);
    ws.close();
    return;
  }

  if (cmd === 'type') {
    const sel = a[0];
    const text = a.slice(1).join(' ');
    const { send, ws } = await connect();
    const js = `(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return 'NOT_FOUND';
      el.focus();
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, ${JSON.stringify(text)}); else el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
      return 'OK';
    })()`;
    const r = await evaluate(send, js);
    console.log(r === 'OK' ? '输入好了' : '没找到输入框 ' + sel);
    log('type ' + sel + ' → ' + r);
    ws.close();
    return;
  }

  if (cmd === 'eval') {
    const { send, ws } = await connect();
    const r = await evaluate(send, a.join(' '));
    console.log(typeof r === 'string' ? r : JSON.stringify(r));
    log('eval ' + a.join(' ').slice(0, 60));
    ws.close();
    return;
  }

  console.log('用法: start [端口] | open <url> | text | click <文字> | type <选择器> <文字> | eval <js> | shot <文件>');
}

main().catch((e) => { log('出错 ' + e.message); console.error('失败：' + e.message); process.exit(1); });
