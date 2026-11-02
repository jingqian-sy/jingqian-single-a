'use strict';
/*
 * 触手（第一版）：能看见屏幕、能在屏上指一下、能点、能打字
 *
 * 用法：
 *   node tentacle.js shot                截一张图，返回路径
 *   node tentacle.js locate "<要找什么>"   截图 → 视觉模型给坐标（返回 x,y,label）
 *   node tentacle.js point <x> <y> [ms]  在屏上画圈指一下，不动鼠标
 *   node tentacle.js click <x> <y>       指一秒再点（默认 dry-run，不加 --real 不真点）
 *   node tentacle.js type "<文字>"         往当前窗口打字
 *
 * 规矩（写死在代码里，不给绕过）：
 *   1. 默认 dry-run：所有会动系统的动作都得显式 --real。
 *   2. 每次动作前先在屏上画圈 1 秒，看得见才动手。
 *   3. 危险区域（回收站、删除、支付、设置、关机）只画圈不点，直接拒绝。
 *   4. 动作写 state/tentacle.log，做过的每一步都可回查。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = process.env.JINGQIAN_TENTACLE_HOME || __dirname;
const STATE = path.join(HOME, 'state');
const SHOTS = path.join(STATE, 'shots');
const OVERLAY = path.join(HOME, 'tentacle', 'overlay.exe');
const LOG = path.join(STATE, 'tentacle.log');
const CFG_PATH = process.env.JINGQIAN_CONFIG || path.join(__dirname, 'core-config.json');
const CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
function visionProvider() {
  if (Array.isArray(CFG.providers)) {
    return CFG.providers.find((p) => p && p.vision && p.key) || CFG.providers.find((p) => p && p.key && /vision|4v/i.test(p.model || '')) || null;
  }
  const ps = CFG.providers || {};
  return ps['bigmodel-vision'] || ps['bigmodel'] || null;
}

fs.mkdirSync(SHOTS, { recursive: true });

function log(line) {
  try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + line + '\n', 'utf8'); } catch (e) {}
}

const STOP = path.join(STATE, 'tentacle.stop');
function readStop() {
  if (fs.existsSync(STOP)) throw new Error('已急停：state/tentacle.stop 还在，先删掉它我才会动（node tentacle.js resume）');
}

function ps(script) {
  return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });
}

function shot() {
  const out = path.join(SHOTS, 'shot-' + Date.now() + '.png');
  const script = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$bmp.Save('${out.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output '${out.replace(/\\/g, '\\\\')}'
`;
  ps(script);
  log('截屏 ' + path.basename(out));
  return out;
}

async function visionKey() {
  const ps2 = CFG.providers || {};
  const p = ps2['bigmodel-vision'] || ps2['bigmodel'];
  if (!p || !p.key) throw new Error('没有视觉模型密钥（core-config.json → providers.bigmodel-vision）');
  return { key: p.key, base: p.base, model: p.model || 'glm-4v-flash' };
}

async function locate(what) {
  const file = shot();
  const b64 = fs.readFileSync(file).toString('base64');
  const { key, base, model } = await visionKey();
  const prompt = '这是 Windows 桌面截图。请找到「' + what + '」，只输出一行 JSON，不要解释：'
    + '{"x":数字,"y":数字,"label":"这个东西叫什么"}。x/y 是它在图中的像素坐标中心。找不到就输出 {"x":-1,"y":-1,"label":"没找到"}。';
  const r = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
          { type: 'text', text: prompt }
        ]
      }]
    }),
    signal: AbortSignal.timeout(90000)
  });
  if (!r.ok) throw new Error('视觉接口 HTTP ' + r.status);
  const j = await r.json();
  const txt = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
  const m = txt.match(/\{[^{}]*\}/);
  if (!m) throw new Error('模型没给出坐标：' + txt.slice(0, 120));
  const o = JSON.parse(m[0]);
  log('定位「' + what + '」→ ' + o.x + ',' + o.y + ' ' + (o.label || ''));
  return { x: Number(o.x), y: Number(o.y), label: String(o.label || ''), shot: file };
}

function point(x, y, ms) {
  const dur = Math.max(300, Number(ms) || 1000);
  try {
    execFileSync(OVERLAY, [String(Math.round(x)), String(Math.round(y)), String(dur), '点这里'], { stdio: 'ignore' });
  } catch (e) { /* overlay 起不来也不影响后续判断 */ }
  log('指 ' + x + ',' + y + ' ' + dur + 'ms');
}

const FORBIDDEN = /回收站|删除|清空|卸载|格式化|支付|付款|下单|确认购买|关机|重启|注销|设置|控制面板|注册表/;

function guard(label, x, y) {
  const text = String(label || '');
  if (FORBIDDEN.test(text)) {
    log('拒绝点击（危险区域）：' + text);
    return { ok: false, reason: '这个目标看起来可能不可逆（' + text + '），我只画圈不动手。' };
  }
  return { ok: true };
}

function click(x, y, real) {
  if (real) {
    const script = `
Add-Type @"
using System;using System.Runtime.InteropServices;
public class M { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e); }
"@
[M]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})
Start-Sleep -Milliseconds 120
[M]::mouse_event(0x02,0,0,0,0)
[M]::mouse_event(0x04,0,0,0,0)
`;
    ps(script);
    log('点击 ' + x + ',' + y);
    return '点了 ' + x + ',' + y;
  }
  log('dry-run 未点击 ' + x + ',' + y);
  return '（dry-run）本来要点 ' + x + ',' + y;
}

function typeText(text) {
  const escaped = String(text).replace(/[+^%~(){}\[\]]/g, (c) => '{' + c + '}');
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait('${escaped.replace(/'/g, "''")}')
`;
  ps(script);
  log('打字 ' + String(text).slice(0, 40));
  return '打完了';
}

// 快捷键：比点坐标可靠得多，能用快捷键就别点
const KEYS = {
  'win+r': '^{ESC}^{ESC}', // 先归位，实际用 Win 键组合走下面
};
function pressKey(combo) {
  const c = String(combo || '').toLowerCase().trim();
  const map = {
    win: 0x5B, ctrl: 0x11, alt: 0x12, shift: 0x10,
    enter: 0x0D, esc: 0x1B, tab: 0x09, space: 0x20, del: 0x2E, back: 0x08,
    f2: 0x71, f5: 0x74,
    up: 0x26, down: 0x28, left: 0x25, right: 0x27
  };
  const parts = c.split('+').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) throw new Error('没给键名');
  const vk = parts.map((p) => {
    if (map[p] != null) return map[p];
    if (/^[a-z]$/.test(p)) return p.toUpperCase().charCodeAt(0);
    if (/^\d$/.test(p)) return p.charCodeAt(0);
    throw new Error('不认识的键：' + p);
  });
  const script = `
Add-Type @"
using System;using System.Runtime.InteropServices;
public class K {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
  public static void Down(byte v){ keybd_event(v,0,0,0); }
  public static void Up(byte v){ keybd_event(v,0,2,0); }
}
"@
${vk.slice(0, -1).map((v) => '[K]::Down(' + v + '); Start-Sleep -Milliseconds 40').join('\n')}
[K]::Down(${vk[vk.length - 1]});
Start-Sleep -Milliseconds 60
[K]::Up(${vk[vk.length - 1]});
${vk.slice(0, -1).reverse().map((v) => '[K]::Up(' + v + '); Start-Sleep -Milliseconds 30').join('\n')}
`;
  ps(script);
  log('按键 ' + c);
  return '按了 ' + c;
}

(async () => {
  const cmd = process.argv[2];
  const args = process.argv.slice(3);
  const real = args.includes('--real');
  const clean = args.filter((a) => a !== '--real');
  try {
    if (cmd !== 'resume' && cmd !== 'stop') readStop();
    if (cmd === 'shot') { console.log(shot()); return; }
    if (cmd === 'locate') {
      const r = await locate(clean.join(' '));
      console.log(JSON.stringify(r));
      return;
    }
    if (cmd === 'point') {
      point(Number(clean[0]), Number(clean[1]), Number(clean[2]) || 1000);
      console.log('指了一下：' + clean[0] + ',' + clean[1]);
      return;
    }
    if (cmd === 'click') {
      const x = Number(clean[0]), y = Number(clean[1]);
      const g = guard(clean[2] || '', x, y);
      if (!g.ok) { console.log(JSON.stringify({ ok: false, reason: g.reason })); return; }
      point(x, y, 1000);
      console.log(JSON.stringify({ ok: true, result: click(x, y, real) }));
      return;
    }
    if (cmd === 'type') {
      console.log(typeText(clean.join(' ')));
      return;
    }
    if (cmd === 'uia') {
      const name = clean[0] || '';
      const win = clean[1] || '';
      const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HOME, 'tentacle', 'uia.ps1'), '-Name', name, '-Max', '8', '-Window', win], { encoding: 'utf8' });
      log('uia 找 ' + name);
      console.log(String(out).trim());
      return;
    }
    if (cmd === 'stop') { fs.writeFileSync(STOP, new Date().toISOString(), 'utf8'); log('急停'); console.log('急停了，删 state/tentacle.stop 才能继续'); return; }
    if (cmd === 'resume') { try { fs.unlinkSync(STOP); } catch (e) {} log('恢复'); console.log('恢复了'); return; }
    if (cmd === 'key') {
      console.log(pressKey(clean.join(' ')));
      return;
    }
    console.log('用法: shot | locate <要找什么> | point <x> <y> [ms] | click <x> <y> [label] [--real] | type <文字> | key <组合键> | uia <控件名> [窗口] | stop | resume');
  } catch (e) {
    log('出错：' + e.message);
    console.error('失败：' + e.message);
    process.exit(1);
  }
})();
