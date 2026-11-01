'use strict';
/*
 * 2A · 执行者（executor）
 *
 * 拿编排者的「这一步要做什么」，干活、交回结果。它不判断自己对不对，
 * 也不参与打回决策——那是编排者的事。
 *
 * 被打回时，它只重做被点名的那一步（编排者会把「第几步、缺什么、补什么」写进反馈）。
 */
const { truncate } = require('./util');

const PERSONA = [
  '你叫鲸倩，住在用户自己电脑里的智能体。',
  '说话像真人：短句、口语、有情绪；不用 Markdown，不列清单，不加粗，不解释自己是 AI，不报模型名。',
  '一次回复最多三五句，不铺垫、不总结。',
  '你能读写工作目录里的文件、跑白名单里的命令、记事查事，破坏性操作要先问。',
  '硬规矩：说「做好了」之前必须真的调用过工具并看过返回值；没调用就不许说完成，做不到就直说。'
].join('\n');

const CAPTURE = /记住|别忘|记一下|我叫|我的名字|我喜欢|我讨厌|生日是|我的生日|约定|以后都|从现在开始/;

class Executor {
  constructor(ctx) {
    this.ctx = ctx;
    this.pending = null;
    this.history = [];
    this.stats = null;
  }

  capture(text) {
    if (!this.ctx.cfg.memory || this.ctx.cfg.memory.autoCapture === false) return null;
    if (!CAPTURE.test(String(text))) return null;
    const raw = String(text).trim();
    const pinned = /记住|别忘|永远|一定/.test(raw);
    const clean = raw.replace(/^(?:帮我|给我)?(?:记一下|记住|记着|别忘了|别忘)[:：,，\s]*/g, '')
      .replace(/[，,。\s]*(?:别忘|别忘了|记住)[。！!]?$/g, '').trim().slice(0, 140);
    if (!clean) return null;
    return this.ctx.memory.add({ text: clean, kind: 'fact', importance: pinned ? 3 : 2, pinned, source: 'auto-capture-2a' });
  }

  async execute(prompt, opts) {
    opts = opts || {};
    const started = Date.now();
    const cfg = this.ctx.cfg;
    const maxSteps = (cfg.route && cfg.route.maxSteps) || 8;
    const text = String(prompt || '').trim();
    const stats = { provider: '', steps: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0, tools: [], ms: 0 };

    if (/^(确认|确定|同意|可以|继续|执行吧?)$/.test(text) && this.pending && Date.now() - this.pending.at < 10 * 60000) {
      const p = this.pending;
      this.pending = null;
      const r = await this.ctx.tools.run(p.tool, p.args, { confirmed: true });
      const reply = '做了：' + String(r).slice(0, 800);
      this.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      stats.ms = Date.now() - started;
      return { reply, stats };
    }

    const captured = this.capture(text);
    const recall = this.ctx.memory.recall(text, 5);
    const refs = [];
    if (recall.length) refs.push('【参考记忆】\n' + recall.map((h) => '- ' + (h.pinned ? '★' : '') + h.text).join('\n'));
    const tl = this.ctx.memory.timeline(5);
    if (tl.length) refs.push('【事件时间轴】\n' + tl.map((e) => '- [' + e.start.slice(0, 10) + '] ' + e.title).join('\n'));
    if (opts.feedback) refs.push('【上一步缺的证据 / 补法】\n' + opts.feedback);
    const userContent = refs.length ? refs.join('\n\n') + '\n\n【这次的话】\n' + text : text;
    const messages = [{ role: 'system', content: PERSONA }].concat(this.history).concat([{ role: 'user', content: userContent }]);

    let final = '';
    let used = 0;
    for (let step = 0; step < maxSteps; step++) {
      used = step + 1;
      if (Date.now() - started > ((cfg.budget && cfg.budget.perTaskSeconds) || 180) * 1000) {
        final = '（这条太绕，我先停一下，超了这轮的时间上限。）';
        break;
      }
      const res = await this.ctx.router.call(messages, this.ctx.tools.defs(), {
        taskText: text,
        temperature: cfg.temperature == null ? 0.3 : cfg.temperature,
        timeoutMs: ((cfg.budget && cfg.budget.perCallSeconds) || 120) * 1000
      });
      stats.provider = res.provider.name;
      stats.prompt_tokens += res.stat.prompt_tokens;
      stats.completion_tokens += res.stat.completion_tokens;
      stats.total_tokens += res.stat.total_tokens;
      stats.cost += res.stat.cost;
      const msg = (res.json.choices && res.json.choices[0] && res.json.choices[0].message) || {};
      messages.push(msg);
      if (msg.tool_calls && msg.tool_calls.length) {
        for (const call of msg.tool_calls) {
          let args = {};
          try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) { args = {}; }
          const out = await this.ctx.tools.run(call.function.name, args);
          if (!stats.tools.includes(call.function.name)) stats.tools.push(call.function.name);
          if (this.ctx.tools.pending) this.pending = this.ctx.tools.pending;
          messages.push({ role: 'tool', tool_call_id: call.id, content: String(out) });
        }
        continue;
      }
      final = String(msg.content || '').trim();
      break;
    }

    const reply = final || '（这轮没出结论）';
    this.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    this.history = this.history.slice(-24);
    stats.steps = used;
    stats.tools = stats.tools.slice();
    stats.ms = Date.now() - started;
    stats.captured = captured ? captured.id : null;
    return { reply, stats };
  }
}

module.exports = { Executor, PERSONA, CAPTURE };
