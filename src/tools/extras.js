'use strict';
/*
 * 从私有版迁过来的「功能类」工具：触手（看屏幕/操作浏览器和桌面）、说话、问本机小模型、子智能体。
 *
 * 设计上跟别的工具一样：都走 safety 红线；触手那些会动系统的动作（点/打字/按键/web_click/web_type/web_eval）
 * 默认是 P1，必须用户点头（core 里那套「确认」重放）才会真的动。
 *
 * 触手脚本放在 tools/tentacle/（从私有版搬来，只改了 HOME/配置路径，让它跟开源版共用 data/）；
 * 这些动作全在本机，不联网（locate 找屏幕元素时会用你配的视觉模型，那一步才联网）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const FEATURE_OF = { tentacle: 'tentacle', speak: 'speak', local_ask: 'local', sub_agent: 'subagent' };

const DEFS = [
  {
    type: 'function',
    function: {
      name: 'tentacle',
      description: '触手碰这台电脑：截屏、找屏幕上的东西、点、打字、按快捷键、看控件；也能操作受控浏览器（开网页、读文字、按文字点、往输入框写）。动作：shot / locate / point / click / type / key / uia / web_start / web_open / web_text / web_click / web_type / web_eval / web_shot / stop / resume。会动系统的动作要先确认。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'shot|locate|point|click|type|key|uia|web_start|web_open|web_text|web_click|web_type|web_eval|web_shot|stop|resume' },
          target: { type: 'string', description: '要找的东西 / 要点的文字 / 网址 / 选择器 / 控件名' },
          text: { type: 'string', description: '要输入的文字' },
          x: { type: 'number' },
          y: { type: 'number' },
          selector: { type: 'string', description: 'web_type 用的 CSS 选择器' },
          window: { type: 'string', description: 'uia 限定窗口名' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'speak',
      description: '开口说话：把一段中文念出来（用系统语音，离线）。适合短句，别一次念一大段。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要说的话，建议 80 字以内' },
          rate: { type: 'number', description: '-10 到 10，默认 0' },
          voice: { type: 'string', description: '系统声音名，可留空（自动挑中文）' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'local_ask',
      description: '叫本机的小模型干活（8b 快、14b 慢）：摘要、分类、改成规整文字这类粗活，不花钱。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '要它做的事' },
          text: { type: 'string', description: '要处理的原文' },
          model: { type: 'string', description: '8b 或 14b，默认 8b' }
        },
        required: ['prompt', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'sub_agent',
      description: '派一个子智能体去做一件具体的活。它自己是一轮独立任务（自己调工具、最多六步），做完只回一段结论。适合能一次交代清楚、但会来回好几轮的活。',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '交代清楚：要做成什么样、边界在哪、要什么形式的结论' },
          model: { type: 'string', description: '留空用当前路由；也可以写 8b / 14b' }
        },
        required: ['task']
      }
    }
  }
];

function featureOn(cfg, feature) {
  const f = (cfg && cfg.features) || {};
  return f[feature] !== false;
}

function defsFor(cfg) {
  return DEFS.filter((d) => {
    const feat = FEATURE_OF[d.function.name];
    return !feat || featureOn(cfg, feat);
  });
}

function runNode(script, argv, ctx, extraEnv, timeoutMs) {
  const dir = path.join(ctx.root, 'tools', 'tentacle');
  const env = Object.assign({}, process.env, extraEnv || {});
  const r = spawnSync(process.execPath, [path.join(dir, script)].concat(argv), {
    cwd: dir,
    env,
    timeout: timeoutMs || 120000,
    encoding: 'utf8',
    windowsHide: true
  });
  const out = String(r.stdout || '').trim();
  const err = String(r.stderr || '').trim();
  if (r.error) throw new Error(r.error.message);
  if (r.status !== 0 && !out) throw new Error(err || ('退出码 ' + r.status));
  return (out || err || '（没输出）');
}

function tentacle(args, ctx) {
  const act = String(args.action || '').toLowerCase();
  const home = path.join(ctx.dataDir, 'tentacle');
  fs.mkdirSync(home, { recursive: true });
  const cfgPath = ctx.configPath || process.env.JQ_CONFIG || path.join(ctx.root, 'config.json');
  const env = { JINGQIAN_TENTACLE_HOME: home, JINGQIAN_CONFIG: cfgPath };
  const confirmed = ctx.confirmed === true;

  if (act === 'shot') return '截好了：' + runNode('tentacle.js', ['shot'], ctx, env);
  if (act === 'locate') return runNode('tentacle.js', ['locate', String(args.target || '')], ctx, env);
  if (act === 'point') return runNode('tentacle.js', ['point', String(args.x), String(args.y), '1200'], ctx, env);
  if (act === 'click') {
    const argv = ['click', String(args.x), String(args.y), String(args.target || '')];
    if (confirmed) argv.push('--real');
    return runNode('tentacle.js', argv, ctx, env);
  }
  if (act === 'type') return runNode('tentacle.js', ['type', String(args.text || '')], ctx, env);
  if (act === 'key') return runNode('tentacle.js', ['key', String(args.target || args.text || '')], ctx, env);
  if (act === 'uia') return runNode('tentacle.js', ['uia', String(args.target || ''), String(args.window || '')], ctx, env);
  if (act === 'stop' || act === 'resume') return runNode('tentacle.js', [act], ctx, env);

  if (act === 'web_start') return runNode('tentacle-web.js', ['start'], ctx, env);
  if (act === 'web_open') return runNode('tentacle-web.js', ['open', String(args.target || '')], ctx, env);
  if (act === 'web_text') return runNode('tentacle-web.js', ['text'], ctx, env);
  if (act === 'web_click') return runNode('tentacle-web.js', ['click', String(args.target || '')], ctx, env);
  if (act === 'web_type') return runNode('tentacle-web.js', ['type', String(args.selector || ''), String(args.text || '')], ctx, env);
  if (act === 'web_eval') return runNode('tentacle-web.js', ['eval', String(args.text || args.target || '')], ctx, env);
  if (act === 'web_shot') return runNode('tentacle-web.js', ['shot', String(args.target || '')], ctx, env);

  return '触手不认识这个动作：' + act;
}

function speak(args, ctx) {
  if (process.platform !== 'win32') return '这台机器没有 Windows 的语音，念不了。';
  const text = String(args.text || '').slice(0, 300);
  if (!text) return '要念什么？';
  const script = path.join(ctx.root, 'tools', 'tentacle', 'tentacle', 'tts.ps1');
  const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Text', text,
    '-Rate', String(Math.max(-10, Math.min(10, Number(args.rate) || 0)))];
  if (args.voice) argv.push('-Voice', String(args.voice));
  const r = spawnSync('powershell', argv, { timeout: 60000, encoding: 'utf8', windowsHide: true });
  if (r.error) return '念不出来：' + r.error.message;
  return '念了：' + text.slice(0, 40) + (text.length > 40 ? '…' : '');
}

async function localAsk(args, ctx) {
  const cfg = ctx.cfg || {};
  const lm = cfg.localModel || {};
  const base = String(lm.base || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const models = lm.models || {};
  const key = String(args.model || '8b').toLowerCase();
  const model = models[key] || models['8b'] || 'qwen3:8b';
  const prompt = String(args.prompt || '') + '\n\n' + String(args.text || '');
  const body = { model, messages: [{ role: 'user', content: prompt }], stream: false };
  const r = await fetch(base + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
  });
  if (!r.ok) throw new Error('本机模型 HTTP ' + r.status);
  const j = await r.json();
  const out = String((j.message && j.message.content) || '').trim();
  return out || '（本机模型没说话）';
}

async function subAgent(args, ctx) {
  if (typeof ctx.subAgent !== 'function') return '子智能体没接上（服务里没注册）。';
  return await ctx.subAgent(String(args.task || ''), args.model);
}

async function run(name, args, ctx) {
  if (name === 'tentacle') return tentacle(args || {}, ctx || {});
  if (name === 'speak') return speak(args || {}, ctx || {});
  if (name === 'local_ask') return await localAsk(args || {}, ctx || {});
  if (name === 'sub_agent') return await subAgent(args || {}, ctx || {});
  return '没有这个工具：' + name;
}

const NAMES = new Set(DEFS.map((d) => d.function.name));

module.exports = { DEFS, defsFor, run, NAMES, FEATURE_OF };
