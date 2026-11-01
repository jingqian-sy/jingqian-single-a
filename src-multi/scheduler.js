'use strict';
/*
 * 3A · 调度角色（scheduler）——整个模板里**唯一**能改任务状态的人
 *
 * 职责：拆任务（计划步骤）、定验收标准、排依赖、发信封、收结果、决定通过/打回/升级。
 * 三条硬规矩：
 *   1) 单写者：状态只在本模块里改，先过 canTransition 再落盘；
 *   2) 每步落盘：状态文件 + 追加日志（journal），进程随时被杀都能恢复；
 *   3) 跨进程通信只认 JSON 信封：写入前 validateEnvelope()，不合格拒收并记 rejected.log。
 *
 * 进程重启恢复：启动时读 state/tasks.json，把 running/inspecting 的任务判为「上次没收尾」，
 * 记一笔 recover，然后重新排队（最多恢复 2 次，超了判失败，不无限重试）。
 */
const fs = require('fs');
const path = require('path');
const {
  makeEnvelope, validateEnvelope, canTransition, TASK_STATES
} = require('./protocol');
const { nowIso, uid, readJson, writeJson, appendJsonl, readJsonl, ensureDir, truncate } = require('./util');

class Scheduler {
  constructor(opts) {
    this.cfg = opts.cfg || {};
    this.root = opts.root;                 // data-multi（或测试用的临时根）
    this.stateDir = path.join(this.root, 'state');
    this.logDir = path.join(this.root, 'logs');
    this.stateFile = path.join(this.stateDir, 'tasks.json');
    this.journalFile = path.join(this.stateDir, 'journal.jsonl');
    this.envelopeFile = path.join(this.logDir, 'envelopes.jsonl');
    this.rejectedFile = path.join(this.logDir, 'rejected.log');
    this.lockFile = path.join(this.stateDir, 'scheduler.lock');
    this.executor = opts.executor;         // 执行角色实例（工厂或对象，见 _executor()）
    this.inspector = opts.inspector;
    this.audit = opts.audit || (() => {});
    this.onEvent = opts.onEvent || (() => {});
    this.role = 'scheduler';
    ensureDir(this.stateDir); ensureDir(this.logDir);
    this.state = readJson(this.stateFile, { version: 1, seq: 0, tasks: {} });
    if (!this.state.tasks) this.state.tasks = {};
    this.locked = false;
  }

  /* ---------- 单写者锁 ---------- */
  acquireLock() {
    if (fs.existsSync(this.lockFile)) {
      const old = readJson(this.lockFile, null);
      const pid = old && old.pid;
      let alive = false;
      if (pid) { try { process.kill(pid, 0); alive = true; } catch (e) { alive = false; } }
      if (alive && pid !== process.pid) throw new Error('已经有一个调度进程在跑（pid ' + pid + '），状态单写者，拒绝第二个。');
    }
    writeJson(this.lockFile, { pid: process.pid, at: nowIso() });
    this.locked = true;
  }

  releaseLock() {
    try {
      const cur = readJson(this.lockFile, null);
      if (cur && cur.pid === process.pid) fs.unlinkSync(this.lockFile);
    } catch (e) {}
    this.locked = false;
  }

  /* ---------- 落盘 ---------- */
  save() {
    this.state.updated_at = nowIso();
    writeJson(this.stateFile, this.state);
  }

  journal(kind, taskId, detail) {
    appendJsonl(this.journalFile, Object.assign({ ts: nowIso(), kind, task_id: taskId, role: 'scheduler' }, detail || {}));
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

  /* ---------- 信封 ---------- */
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

  /* ---------- 提交任务 ---------- */
  submit(def) {
    const id = def.id || uid('task');
    if (this.state.tasks[id]) return this.state.tasks[id];
    const task = {
      id,
      prompt: def.prompt || '',
      turns: Array.isArray(def.turns) && def.turns.length ? def.turns.slice() : null,
      acceptance: def.acceptance || [],
      depends_on: def.depends_on || [],
      plan: def.plan || ['execute', 'inspect'],
      status: 'pending',
      rework_round: 0,
      exec_retry: 0,
      recover_count: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
      stats: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0, steps: 0, ms: 0, tools: [], provider: '' },
      inspections: [],
      reply: '',
      error: '',
      transitions: []
    };
    this.state.tasks[id] = task;
    this.state.seq = (this.state.seq || 0) + 1;
    this.save();
    this.journal('submitted', id, { prompt: truncate(task.prompt, 80) });
    return task;
  }

  pending() {
    return Object.values(this.state.tasks).filter((t) => !['done', 'failed', 'escalated'].includes(t.status));
  }

  /* ---------- 重启恢复 ---------- */
  recover() {
    const broken = Object.values(this.state.tasks).filter((t) => t.status === 'running' || t.status === 'inspecting');
    const report = [];
    for (const task of broken) {
      task.recover_count = (task.recover_count || 0) + 1;
      task.transitions = (task.transitions || []).concat([{ at: nowIso(), from: task.status, to: 'planned', note: '进程重启恢复 #' + task.recover_count }]);
      const was = task.status;
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

  /* ---------- 执行 + 质检主循环 ---------- */
  _executor(taskId) {
    // 同一个任务（含多轮对话）复用同一个执行实例，才接得上「确认」和被拦下的那一步
    this._execCtx = this._execCtx || new Map();
    if (taskId) {
      if (!this._execCtx.has(taskId)) {
        this._execCtx.set(taskId, typeof this.executor === 'function' ? this.executor() : this.executor);
      }
      return this._execCtx.get(taskId);
    }
    return typeof this.executor === 'function' ? this.executor() : this.executor;
  }

  _dropExecutor(taskId) {
    if (this._execCtx) this._execCtx.delete(taskId);
  }

  async _execOneTurn(task, prompt, feedback) {
    const ex = this._executor(task.id);
    const payloadIn = { prompt, feedback: feedback || '' };
    this.send('scheduler', 'executor', task.id, 'dispatched', payloadIn);
    const t0 = Date.now();
    const timeoutMs = ((this.cfg.budget && this.cfg.budget.perTaskSeconds) || 180) * 1000;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('执行超时（>' + Math.round(timeoutMs / 1000) + 's）')), timeoutMs);
    });
    let out;
    try {
      out = await Promise.race([ex.execute(prompt, { feedback }), timeout]);
    } finally {
      clearTimeout(timer);
    }
    const env = this.send('executor', 'scheduler', task.id, 'completed', {
      reply: truncate(out.reply, 4000),
      stats: out.stats,
      elapsed_ms: Date.now() - t0
    });
    return { reply: out.reply, stats: out.stats, envelope: env };
  }

  pileStats(task, s) {
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

  async runTask(id) {
    const task = this.state.tasks[id];
    if (!task) throw new Error('没有这个任务：' + id);
    if (['done', 'failed', 'escalated'].includes(task.status)) return task;

    // 依赖没完成就先等（简单拓扑：只等前置任务）
    for (const dep of task.depends_on || []) {
      const d = this.state.tasks[dep];
      if (d && !['done', 'failed', 'escalated'].includes(d.status)) await this.runTask(dep);
      const dd = this.state.tasks[dep];
      if (dd && dd.status !== 'done') {
        task.error = '前置任务 ' + dep + ' 没成功（' + dd.status + '）';
        if (canTransition(task.status, 'failed')) this.transition(task, 'failed', task.error);
        return task;
      }
    }

    if (task.status === 'pending') this.transition(task, 'planned', '准备执行');

    // 被打回过就从 rework 回到 running；正常从 planned 进 running
    for (;;) {
      if (task.status === 'rework') this.transition(task, 'running', '第 ' + (task.rework_round + 1) + ' 轮重试');
      else if (task.status === 'planned') this.transition(task, 'running', '提交执行角色');

      const feedback = task.last_feedback || '';
      const turns = task.turns && task.turns.length ? task.turns : [task.prompt];
      let last = { reply: '', stats: null };
      try {
        for (const t of turns) {
          last = await this._execOneTurn(task, t, feedback);
          this.pileStats(task, last.stats);
        }
        task.reply = last.reply;
        this.transition(task, 'inspecting', '交质检');
      } catch (e) {
        task.exec_retry = (task.exec_retry || 0) + 1;
        task.error = e.message;
        this.journal('exec_error', task.id, { error: e.message, retry: task.exec_retry });
        if (task.exec_retry <= 1 && canTransition(task.status, 'planned')) {
          this.transition(task, 'planned', '执行出错，重试一次（上限 1 次）');
          this._dropExecutor(task.id);
          continue;
        }
        if (canTransition(task.status, 'failed')) this.transition(task, 'failed', '执行失败：' + e.message);
        return task;
      }

      // 质检
      this.send('scheduler', 'inspector', task.id, 'dispatched', {
        acceptance: task.acceptance,
        round: task.rework_round,
        reply: truncate(task.reply, 4000),
        stats: task.stats
      });
      const verdict = await this.inspector.inspect(task, { reply: task.reply, stats: task.stats });
      task.inspections.push({ at: nowIso(), round: task.rework_round, pass: verdict.pass, failed: verdict.failed });
      this.send('inspector', 'scheduler', task.id, 'completed', {
        pass: verdict.pass, score: verdict.score, failed: verdict.failed, round: verdict.round
      });
      this.save();

      if (verdict.pass) {
        this.transition(task, 'done', '质检通过');
        return task;
      }

      if (task.rework_round >= 2) {
        task.error = '质检打回 2 轮仍不合格，升级给人：' + (verdict.failed[0] || '');
        this.send('scheduler', 'human', task.id, 'escalated', { reason: task.error, failed: verdict.failed });
        this.transition(task, 'escalated', '打回上限，升级给人');
        return task;
      }

      task.rework_round += 1;
      task.last_feedback = '上一轮没过：' + verdict.failed.join('；') + '。按这个改，别重复同样的错。';
      this.transition(task, 'rework', '质检打回第 ' + task.rework_round + ' 轮');
      // 打回时换一个干净的执行上下文，否则它会以为上一轮已经「做完了」
      this._dropExecutor(task.id);
    }
  }

  async runAll() {
    const ids = Object.values(this.state.tasks)
      .filter((t) => !['done', 'failed', 'escalated'].includes(t.status))
      .map((t) => t.id);
    for (const id of ids) {
      await this.runTask(id);
    }
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
      tokens: tasks.reduce((n, t) => n + t.stats.total_tokens, 0),
      cost: Math.round(tasks.reduce((n, t) => n + t.stats.cost, 0) * 1e6) / 1e6
    };
  }
}

module.exports = { Scheduler, TASK_STATES };
