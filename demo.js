'use strict';
/*
 * 30 秒演示：记一件事 → 问回来 → 跑一条白名单命令。
 *
 *   node demo.js          # demo.cmd / demo.sh 调的就是它
 *
 * 不给真 key：优先本机 Ollama；没有任何可用模型就明确告诉你缺什么、怎么补，然后干净退出。
 * 演示数据写在 .demo/ 里（已 gitignore），不碰你平时聊出来的记忆和成绩报表。
 */
const fs = require('fs');
const path = require('path');
const { Her } = require('./src/core');
const { loadCfg } = require('./evals/lib/harness');

const ROOT = __dirname;
const HOME = path.join(ROOT, '.demo');
const LINE = '─'.repeat(56);

function out(s) { console.log(s); }
function title(s) { out('\n' + LINE + '\n  ' + s + '\n' + LINE); }

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }

function hasLocal(cfg) {
  return (cfg.providers || []).some((p) => (p.tier === 'local' || /11434/.test(p.base || '')));
}

async function ollamaUp() {
  try {
    const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch (e) { return false; }
}

function degrade(reason) {
  out('');
  out('  ' + reason);
  out('');
  out('  这版演示需要有「一个能用的模型」。两条路，选一条：');
  out('    1) 本地（不要钱）：装 Ollama，然后  ollama pull qwen3:8b');
  out('       起来之后 ollama serve（通常装完自动在跑），再跑一次 demo');
  out('    2) 云端（要 key）：复制 config.example.json 成 config.json，');
  out('       把 providers 里 deepseek 的 key 填上（或设环境变量 DEEPSEEK_API_KEY）');
  out('');
  out('  没有 key 也能跑的部分：node evals/test-judge.js / node evals/test-tools.js');
  out('  （CI 就是用 mock 模型跑这些，完全不联网。）');
  out('');
}

async function main() {
  const cfg = loadCfg();
  const providers = cfg.providers || [];
  const ready = providers.filter((p) => p.tier === 'local' || (p.key && String(p.key).trim()));
  if (!ready.length) return degrade('演示没跑起来：config.json 里一个可用的模型都没有。');

  const local = providers.find((p) => p.tier === 'local' || /11434/.test(p.base || ''));
  if (local) {
    const up = await ollamaUp();
    if (!up) {
      out('');
      out('  提示：本机 Ollama（127.0.0.1:11434）没在跑，本地模型用不了。');
      if (ready.some((p) => p.tier !== 'local')) out('  下面会用云端模型继续演示（你的 key，花的是你的额度）。');
      else return degrade('演示没跑起来：本地 Ollama 没在跑，也没有云端 key。');
    }
  }

  // 每次演示都从干净状态开始，讲清楚「发生了什么」比攒历史重要
  rmrf(HOME);
  const her = new Her({ root: HOME, cfg });
  const t0 = Date.now();
  out('');
  out('  鲸倩 · 单A 雏版 · 30 秒演示');
  out('  模型：' + ready.map((p) => p.name + '/' + p.model).join('、'));
  out('  （本地 8B 会慢一点，跑完大概半分钟到一分钟；看输出比看速度重要）');
  out('  数据：' + path.relative(ROOT, her.dataDir).replace(/\\/g, '/') + '/（演示完可以整个删掉）');

  title('第 1 步：让她记一件事');
  out('  你：帮我记一下：我每周三晚上打羽毛球，别忘。');
  let r = await her.chat('帮我记一下：我每周三晚上打羽毛球，别忘。', { sessionId: 'demo' });
  out('  她：' + String(r.reply).replace(/\n/g, ' '));
  out('  → 记忆库里现在有 ' + her.store.count() + ' 条（' + path.relative(ROOT, path.join(her.dataDir, 'memory', 'memories.json')).replace(/\\/g, '/') + '）');

  title('第 2 步：问回来');
  out('  你：我周三晚上一般干嘛来着？');
  r = await her.chat('我周三晚上一般干嘛来着？', { sessionId: 'demo' });
  out('  她：' + String(r.reply).replace(/\n/g, ' '));
  out('  → 这轮召回 ' + (r.stats.memory_used || 0) + ' 条记忆（关键词' + (r.stats.memory_vector ? ' + 向量' : '') + '召回）');

  title('第 3 步：跑一条命令（走红线 + 白名单）');
  out('  调工具：run_command("echo 鲸倩演示通过")');
  const toolOut = await her.tools.run('run_command', { command: 'echo 鲸倩演示通过' });
  out('  ' + String(toolOut).split('\n').join('\n  '));
  let auditLevel = '?';
  try {
    const lines = fs.readFileSync(path.join(her.dataDir, 'audit.log'), 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    auditLevel = last.level + (last.allowed ? ' 放行' : ' 拦下');
  } catch (e) { /* 审计读不到不影响演示 */ }
  out('  → 审计：' + auditLevel + '（每条工具调用都留档）');

  const ms = Date.now() - t0;
  out('\n' + LINE);
  out('  三步走完，用时 ' + (Math.round(ms / 100) / 10) + ' 秒');
  out('  这轮 tokens：' + (r.stats.total_tokens || 0) + '；本地模型花费 0 元（云端才计费）');
  out('  下一步：run.cmd 起服务 → http://127.0.0.1:7889');
  out(LINE + '\n');
}

main().catch((e) => {
  console.error('演示出错：' + e.message);
  console.error('常见原因：本地没 pull 这个模型（先 `ollama list` 看看名字对不对，');
  console.error('config.json 里 model 要写成你本地实际有的那个 tag）、或者 key 没填 / 余额不足。');
  process.exit(1);
});
