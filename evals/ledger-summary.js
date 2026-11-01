'use strict';
/*
 * 把评测结果（data/results.json）折算成「账本口径」的汇总，方便做省钱对比。
 *
 *   node evals/ledger-summary.js
 *
 * 输出 data/ledger-summary.json。为什么要有它：
 *   - 评测跑在隔离目录（evals/.run）里，逐次调用的账本文件不会留在 data/ledger；
 *   - results.json 里每一次调用都记了 provider / 输入 tokens / 输出 tokens，和账本同源同口径；
 *   - 这里只做聚合，不发明数字，并在输出里写清 derived_from 和 run_id，可复核。
 *
 * 单价不是猜的：见 docs/省钱对比.md 里的「单价来源」，折算用 DeepSeek 官方定价页
 * （2026-11-01 查）deepseek-flash 高峰/空闲两档，以及 v4-pro 高峰档，对比用。
 */
const fs = require('fs');
const path = require('path');
const { readJson, writeJson } = require('../src/util');

const ROOT = path.join(__dirname, '..');
const RESULTS = path.join(ROOT, 'data', 'results.json');
const OUT = path.join(ROOT, 'data', 'ledger-summary.json');

// 元 / 百万 tokens，来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing（2026-11-01 查）
const PRICES = {
  'deepseek-flash 高峰': { in: 2, out: 8, source: 'deepseek 官方定价页，2026-11-01' },
  'deepseek-flash 空闲': { in: 1, out: 4, source: 'deepseek 官方定价页（空闲时段价格为高峰一半），2026-11-01' },
  'deepseek-v4-pro 高峰': { in: 9, out: 27, source: 'deepseek 官方定价页，2026-11-01' }
};

function main() {
  const r = readJson(RESULTS, null);
  if (!r) {
    console.error('没有 data/results.json，先跑 node evals/run.js --run');
    process.exit(2);
  }
  const byProvider = {};
  const byGroup = {};
  let p = 0, c = 0, calls = 0, ms = 0;
  for (const t of r.tasks) {
    for (const a of t.attempts) {
      const prov = a.provider || 'unknown';
      const g = t.group || 'other';
      byProvider[prov] = byProvider[prov] || { calls: 0, prompt_tokens: 0, completion_tokens: 0, model: prov };
      byProvider[prov].calls++;
      byProvider[prov].prompt_tokens += a.prompt_tokens || 0;
      byProvider[prov].completion_tokens += a.completion_tokens || 0;
      byGroup[g] = byGroup[g] || { attempts: 0, prompt_tokens: 0, completion_tokens: 0 };
      byGroup[g].attempts++;
      byGroup[g].prompt_tokens += a.prompt_tokens || 0;
      byGroup[g].completion_tokens += a.completion_tokens || 0;
      p += a.prompt_tokens || 0;
      c += a.completion_tokens || 0;
      calls++;
      ms += a.ms || 0;
    }
  }
  const equivalents = {};
  for (const [name, price] of Object.entries(PRICES)) {
    equivalents[name] = {
      prompt_tokens: p,
      completion_tokens: c,
      price_in: price.in,
      price_out: price.out,
      cost_cny: Math.round(((p / 1e6) * price.in + (c / 1e6) * price.out) * 1e6) / 1e6
    };
  }
  const out = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    derived_from: 'data/results.json',
    run_id: r.run_id,
    run_started_at: r.started_at,
    run_finished_at: r.finished_at,
    tasks: r.tasks.length,
    attempts: calls,
    total_ms: ms,
    tokens: { prompt: p, completion: c, total: p + c },
    by_provider: byProvider,
    by_group: byGroup,
    equivalents,
    note: '按 results.json 里每次调用的 provider / 输入输出 tokens 聚合；单价见 docs/省钱对比.md「单价来源」。'
  };
  writeJson(OUT, out);
  console.log('写好了 ' + path.relative(ROOT, OUT));
  console.log('run_id ' + r.run_id + ' · ' + calls + ' 次调用 · ' + (p + c) + ' tokens');
  for (const [k, v] of Object.entries(equivalents)) console.log('  ' + k + '：' + v.cost_cny.toFixed(6) + ' 元');
}

main();
