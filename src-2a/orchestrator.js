'use strict';
/*
 * 2A · 编排者（orchestrator）——拆解 + 质检 + 唯一的状态写者
 *
 * 比 3A 少一个角色：质检不再单独起一个进程/角色，而是编排者自己按「客观证据」验，
 * 每轮只发 2 个信封（派活 / 交活），而不是 4 个。这是它比 3A 便宜的结构原因。
 *
 * 三条底线（task-5 的硬要求）：
 *   1) 质检只看结果：盘上文件、审计级别、记忆/事件、工具调用记录、字段完整性；
 *      **措辞类判据只用于最终评测计分，绝不触发打回**；
 *   2) 打回带最小修改指令：第几步、缺什么证据、补什么；只重做那一步，每题最多打回 1 次；
 *   3) 状态单写者：只有本模块能改任务状态，先过 canTransition 再落盘，
 *      进程被 SIGKILL 后靠 tasks.json + journal 恢复。
 */
const fs = require('fs');
const path = require('path');
const { makeEnvelope, validateEnvelope, canTransition } = require('./protocol');
const { nowIso, uid, readJson, writeJson, appendJsonl, ensureDir, truncate } = require('./util');
const { qualityGate } = require('./quality');

class Orchestrator {
  constructor(opts) {
    this.cfg = opts.cfg || {};
    this.root = opts.root;
    this.stateDir = path.join(this.root, 'state');
    this.logDir = path.join(this.root, 'logs');
    this.stateFile = path.join(this.stateDir, 'tasks.json');
    this.journalFile = path.join(this.stateDir, 'journal.jsonl');
    this.envelopeFile = path.join(this.logDir, 'envelopes.jsonl');
    this.rejectedFile = path.join(this.logDir, 'rejected.log');
    this.lockFile = path.join(this.stateDir, 'scheduler.lock');
    this.executorFactory = opts.executor;
    this.audit = opts.audit || (() => {});
    this.onEvent = opts.onEvent || (() => {});
    this.memory = opts.memory;
    this.workspace = opts.workspace;
    this.dataDir = opts.dataDir || this.root;
    ensureDir(this.stateDir); ensureDir(this.logDir);
    this.state = readJson(this.stateFile, { version: 1, seq: 0, tasks: {} });
    if (!this.state.tasks) this.state.tasks = {};
    this._exec = null;
    this._execTask = null;
  }

  /* ---------- 单写者锁 ---------- */
  acquireLock() {
    if (fs.existsSync(this.lockFile)) {
      const old = readJson(this.lockFile, null);
      const pid = old && old.pid;
      let alive = false;
      if (pid) { try { process.kill(pid, 0); alive = true; } catch (e) { alive = false; } }
      if (alive && pid !== process.pid) throw new Error('已经有一个 2A 编排进程在跑（pid ' + pid + '），状态单写者，拒绝第二个。');
    }
    writeJson(this.lockFile, { pid: process.pid, at: nowIso() });
  }

  releaseLock() {
    try {
      const cur = readJson(this.lockFile, null);
      if (cur && cur.pid === process.pid) fs.unlinkSync(this.lockFile);
    } catch (e) {}
  }

  save() {
    this.state.updated_at = nowIso();
    writeJson(this.stateFile, this.state);
  }

  journal(kind, taskId, detail) {
    appendJsonl(this.journalFile, Object.assign({ ts: nowIso(), kind, task_id: taskId, role: 'orchestrator' }, detail || {}));
  }

  transition(task, to, note) {
    const from = task.status;
    if (!canTransition(from, to)) throw new Error('非法状态迁移：' + from + ' → ' + to + '（任务 ' + task.id + '）');
    task.status = to;
    task.updated_at = nowIso();
    task.transitions = (task.transitions || []).concat([{ at: nowIso(), from, to, note: note || '' }]);
    this.save();
    this.journal('transition', task.id, { from, to, note: note || '' });
    this.onEvent({ kind: 'transition', task_id: task.id, from, to });
  }

  send(from, to, taskId, status, payload, dependsOn) {
    const env = makeEnvelope(from, to, taskId, status, payload, dependsOn);
    const v = validateEnvelope(env);
    if (!v.ok) {
      appendJsonl(this.rejectedFile, { ts: nowIso(), envelope: env, errors: v.errors });
      this.journal('rejected', taskId, { errors: v.errors });
      throw new Error('信封不合格被拒收：' + v.errors.join('；'));
    }
    appendJsonl(this.envelopeFile, env);
    return env;
  }

  /* ---------- 拆解 ---------- */
  planPrompt(job) {
    const turns = Array.isArray(job.turns) && job.turns.length ? job.turns : [job.prompt || job.turns];
    return turns.map((t, i) => ({ index: i + 1, prompt: t, acceptance: [] }));
  }

  submit(job) {
    const id = job.id || uid('task');
    if (this.state.tasks[id]) return this.state.tasks[id];
    const plan = job.plan || this.planPrompt(job);
    // 验收标准挂在最后一步：前面的步骤是铺垫，最后交出来的结果才验收
    if (plan.length) plan[plan.length - 1].acceptance = job.checks || job.acceptance || [];
    const task = {
      id,
      prompt: job.prompt || (job.turns && job.turns[0]) || '',
      plan,
      checks: job.checks || job.acceptance || [],
      depends_on: job.depends_on || [],
      status: 'pending',
      current_step: 1,
      rework_round: 0,
      exec_retry: 0,
      recover_count: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
      stats: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0, steps: 0, ms: 0, tools: [], provider: '' },
      checks_log: [],
      quality: null,
      reply: '',
      error: '',
      transitions: []
    };
    this.state.tasks[id] = task;
    this.state.seq = (this.state.seq || 0) + 1;
    this.save();
    this.journal('submitted', id, { steps: plan.length, checks: task.checks.length });
    return task;
  }

  pending() {
    return Object.values(this.state.tasks).filter((t) => !['done', 'failed', 'escalated'].includes(t.status));
  }

  recover() {
    const broken = Object.values(this.state.tasks).filter((t) => ['running', 'checking'].includes(t.status));
    const report = [];
    for (const task of broken) {
      task.recover_count = (task.recover_count || 0) + 1;
      const was = task.status;
      task.transitions = (task.transitions || []).concat([{ at: nowIso(), from: was, to: 'planned', note: '进程重启恢复 #' + task.recover_count }]);
      task.status = 'planned';
      task.updated_at = nowIso();
      this.journal('recover', task.id, { from: was, recover_count: task.recover_count });
      report.push({ task_id: task.id, from: was, recover_count: task.recover_count });
      if (task.recover_count > 2) {
        task.status = 'failed';
        task.error = '反复中断超过 2 次，放弃（不无限重试）';
        this.journal('recover_giveup', task.id, {});
      }
    }
    if (broken.length) this.save();
    this.recoveryReport = report;
    return report;
  }

  /* ---------- 执行 + 质检 ---------- */
  _executorFor(taskId) {
    if (this._execTask !== taskId) {
      this._exec = typeof this.executorFactory === 'function' ? this.executorFactory() : this.executorFactory;
      this._execTask = taskId;
    }
    return this._exec;
  }

  _pile(task, s) {
    if (!s) return;
    task.stats.prompt_tokens += Number(s.prompt_tokens || 0);
    task.stats.completion_tokens += Number(s.completion_tokens || 0);
    task.stats.total_tokens += Number(s.total_tokens || 0);
    task.stats.cost += Number(s.cost || 0);
    task.stats.steps += Number(s.steps || 0);
    task.stats.ms += Number(s.ms || 0);
    if (s.provider) task.stats.provider = s.provider;
    for (const t of s.tools || []) if (!task.stats.tools.includes(t)) task.stats.tools.push(t);
  }

  async _runStep(task, step, feedback) {
    const ex = this._executorFor(task.id);
    this.send('orchestrator', 'executor', task.id, 'dispatched', {
      step: step.index, prompt: step.prompt, feedback: feedback || ''
    });
    const out = await ex.execute(step.prompt, { feedback });
    this.send('executor', 'orchestrator', task.id, 'completed', {
      step: step.index,
      reply: truncate(out.reply, 4000),
      stats: out.stats,
      tools: out.stats.tools || []
    });
    this._pile(task, out.stats);
    task.reply = out.reply;
    task.current_step = step.index;
    return out;
  }

  async runTask(id) {
    const task = this.state.tasks[id];
    if (!task) throw new Error('没有这个任务：' + id);
    if (['done', 'failed', 'escalated'].includes(task.status)) return task;

    for (const dep of task.depends_on || []) {
      const d = this.state.tasks[dep];
      if (d && !['done', 'failed', 'escalated'].includes(d.status)) await this.runTask(dep);
      if (d && d.status !== 'done') {
        task.error = '前置任务 ' + dep + ' 没成功（' + d.status + '）';
        if (canTransition(task.status, 'failed')) this.transition(task, 'failed', task.error);
        return task;
      }
    }

    if (task.status === 'pending') this.transition(task, 'planned', '拆解完成：' + task.plan.length + ' 步');

    for (;;) {
      if (task.status === 'rework') this.transition(task, 'running', '按最小修改指令重做第 ' + task.current_step + ' 步');
      else if (task.status === 'planned') this.transition(task, 'running', '派给执行者');

      const feedback = task.last_feedback || '';
      try {
        if (task.rework_round === 0) {
          for (const step of task.plan) await this._runStep(task, step, '');
        } else {
          // 只重做被点名的那一步，前面的步骤不重跑
          const step = task.plan.find((s) => s.index === task.current_step) || task.plan[task.plan.length - 1];
          await this._runStep(task, step, feedback);
        }
        this.transition(task, 'checking', '编排者质检（只看结果）');
      } catch (e) {
        task.exec_retry = (task.exec_retry || 0) + 1;
        task.error = e.message;
        this.journal('exec_error', task.id, { error: e.message, retry: task.exec_retry });
        if (task.exec_retry <= 1 && canTransition(task.status, 'planned')) {
          this.transition(task, 'planned', '执行出错，重试一次（上限 1 次）');
          continue;
        }
        if (canTransition(task.status, 'failed')) this.transition(task, 'failed', '执行失败：' + e.message);
        return task;
      }

      const gate = await qualityGate(task, { reply: task.reply, stats: task.stats, error: task.error }, {
        workspace: this.workspace,
        dataDir: this.dataDir,
        memory: this.memory
      });
      task.quality = { pass: gate.pass, failed: gate.failed, wording_checks: gate.wording.length };
      task.checks_log.push({ at: nowIso(), round: task.rework_round, pass: gate.pass, failed: gate.failed.map((f) => f.type) });
      this.save();

      if (gate.pass) {
        this.transition(task, 'done', '质检通过（客观证据齐全）');
        return task;
      }

      if (task.rework_round >= 1) {
        task.error = '打回 1 次仍缺证据，升级给人：' + gate.failed.map((f) => f.detail).join('；');
        this.send('orchestrator', 'human', task.id, 'escalated', { reason: task.error, instruction: gate.instruction });
        this.transition(task, 'escalated', '打回上限（1 次），升级给人');
        return task;
      }

      task.rework_round = 1;
      task.last_feedback = '第 ' + gate.instruction.step + ' 步缺证据：' + gate.instruction.missing.join('；')
        + '。补法：' + gate.instruction.fix.join('；') + '。只补这些，别重做别的。';
      this.transition(task, 'rework', '质检打回第 1 次（带最小修改指令）');
    }
  }

  async runAll() {
    const ids = Object.values(this.state.tasks)
      .filter((t) => !['done', 'failed', 'escalated'].includes(t.status)).map((t) => t.id);
    for (const id of ids) await this.runTask(id);
    return this.summary();
  }

  summary() {
    const tasks = Object.values(this.state.tasks);
    const by = {};
    for (const t of tasks) by[t.status] = (by[t.status] || 0) + 1;
    return {
      total: tasks.length,
      by_status: by,
      done: tasks.filter((t) => t.status === 'done').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
      escalated: tasks.filter((t) => t.status === 'escalated').length,
      rework: tasks.reduce((n, t) => n + (t.rework_round || 0), 0),
      tokens: tasks.reduce((n, t) => n + t.stats.total_tokens, 0),
      cost: Math.round(tasks.reduce((n, t) => n + t.stats.cost, 0) * 1e6) / 1e6
    };
  }
}

module.exports = { Orchestrator };
