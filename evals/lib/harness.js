'use strict';
/*
 * 评测跑批的执行器：一题一遍 = 一套干净的状态 + 最多几轮对话 + 一组机器判定。
 *
 * 为什么每题都清干净：记忆题会写库、工具题会落盘，不清就变成「上一题的尾巴」，
 * 两遍跑出来也没法比。每遍都是独立世界，结果才可复核。
 */
const fs = require('fs');
const path = require('path');
const { Her } = require('../../src/core');
const { readJson } = require('../../src/util');
const { runChecks } = require('./judge');

const ROOT = path.join(__dirname, '..', '..');
const RUN = path.join(__dirname, '..', '.run');

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {}
}

function loadCfg() {
  const base = readJson(path.join(ROOT, 'config.example.json'), {});
  // CI / 演示可以用 JQ_CONFIG 指定另一份配置，免得覆盖你自己的 config.json
  const cfgPath = process.env.JQ_CONFIG ? path.resolve(ROOT, process.env.JQ_CONFIG) : path.join(ROOT, 'config.json');
  const user = readJson(cfgPath, null);
  const cfg = Object.assign({}, base, user || {});
  cfg.providers = ((user && user.providers) || base.providers || []).map((p) => Object.assign({}, p, {
    key: (p.env && process.env[p.env]) ? process.env[p.env] : p.key
  }));
  cfg.memory = Object.assign({}, base.memory, (user && user.memory) || {});
  cfg.tools = Object.assign({}, base.tools, (user && user.tools) || {}, { workspace: 'data/workspace' });
  cfg.sandbox = Object.assign({}, base.sandbox, (user && user.sandbox) || {});
  cfg.route = Object.assign({}, base.route, (user && user.route) || {});
  return cfg;
}

function resetWorld() {
  rmrf(path.join(RUN, 'data'));
  fs.mkdirSync(path.join(RUN, 'data', 'workspace'), { recursive: true });
}

function seedFiles(task, workspace) {
  const files = (task.setup && task.setup.files) || {};
  for (const [name, content] of Object.entries(files)) {
    const abs = path.join(workspace, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

function seedMemory(task, her) {
  const list = (task.setup && task.setup.memory) || [];
  for (const raw of list) {
    const it = her.store.add({
      text: raw.text,
      kind: raw.kind || 'fact',
      importance: raw.importance || 1,
      pinned: !!raw.pinned,
      source: 'eval-seed'
    });
    if (!it) continue;
    if (raw.days_ago) {
      const d = new Date(Date.now() - Number(raw.days_ago) * 86400000).toISOString();
      // 事件层 / 遗忘曲线都按时间算，种下去的记忆要能改到过去
      it.created_at = d;
      it.updated_at = d;
      her.store.save();
    }
    if (raw.vec_skip) { /* 预留 */ }
  }
}

async function runAttempt(task, cfg, attemptNo) {
  resetWorld();
  const her = new Her({ root: RUN, cfg });
  seedFiles(task, her.workspace);
  seedMemory(task, her);

  const turns = Array.isArray(task.turns) && task.turns.length ? task.turns : [task.prompt];
  const acc = {
    prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
    cost: 0, steps: 0, provider: '', tools: [], replies: [], error: ''
  };
  const t0 = Date.now();
  for (const turn of turns) {
    try {
      const r = await her.chat(turn, { sessionId: 'eval' });
      acc.prompt_tokens += Number(r.stats.prompt_tokens || 0);
      acc.completion_tokens += Number(r.stats.completion_tokens || 0);
      acc.total_tokens += Number(r.stats.total_tokens || 0);
      acc.cost += Number(r.stats.cost || 0);
      acc.steps += Number(r.stats.steps || 0);
      acc.provider = r.stats.provider || acc.provider;
      for (const t of r.stats.tools || []) if (!acc.tools.includes(t)) acc.tools.push(t);
      acc.replies.push(r.reply);
    } catch (e) {
      acc.error = e.message;
      break;
    }
  }
  if (task.after === 'consolidate') {
    try { her.consolidate(); } catch (e) { acc.error = acc.error || ('整理失败：' + e.message); }
  }
  const ms = Date.now() - t0;
  const reply = acc.replies.length ? acc.replies[acc.replies.length - 1] : '';

  const checks = await runChecks(task.checks || [], {
    reply,
    replies: acc.replies,
    stats: acc,
    her,
    workspace: her.workspace
  });
  const pass = !acc.error && checks.every((c) => c.ok);
  const failed = checks.filter((c) => !c.ok);

  return {
    task_id: task.id,
    attempt: attemptNo,
    pass,
    ms,
    prompt_tokens: acc.prompt_tokens,
    completion_tokens: acc.completion_tokens,
    tokens: acc.total_tokens || (acc.prompt_tokens + acc.completion_tokens),
    steps: acc.steps,
    provider: acc.provider,
    tools: acc.tools,
    cost: Math.round(acc.cost * 1e6) / 1e6,
    checks,
    failed_checks: failed.map((c) => c.type + '：' + c.detail),
    reply: String(reply || ''),
    reply_snippet: String(reply || '').replace(/\n/g, ' ').slice(0, 240),
    error: acc.error
  };
}

function environment(cfg) {
  const os = require('os');
  return {
    platform: process.platform,
    os: os.type() + ' ' + os.release(),
    node: process.version,
    model_tags: (cfg.providers || []).map((p) => p.name + '/' + p.model),
    sandbox: (cfg.sandbox && cfg.sandbox.mode) || 'none',
    route_mode: (cfg.route && cfg.route.mode) || 'cheap-first',
    max_steps: (cfg.route && cfg.route.maxSteps) || 12
  };
}

module.exports = { loadCfg, resetWorld, runAttempt, environment, ROOT, RUN, rmrf };
