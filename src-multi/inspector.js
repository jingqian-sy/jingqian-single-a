'use strict';
/*
 * 3A · 质检角色（inspector）
 *
 * 按调度给出的「验收标准」给执行结果打分：
 *   - 能看盘就看盘（文件/审计/记忆/事件层），其余用明确正则；
 *   - 不合格 → 打回（rework），带着失败理由回去；
 *   - 最多打回 2 轮，第 3 次还不过 → 升级给人（escalated）。
 *
 * 注意：判定函数用的是评测里那把共用的尺子（evals/lib/judge.js），
 * 因为两个模板要比成绩，必须用同一套判定；但质检的编排、打回、escalate
 * 这些都是 3A 自己实现的，不共用单A 的任何编排代码。
 */
const { runChecks } = require('../evals/lib/judge');
const { nowIso } = require('./util');

class Inspector {
  constructor(ctx) {
    this.ctx = ctx; // { audit }
  }

  async inspect(job, execResult) {
    const checks = job.acceptance || [];
    const results = await runChecks(checks, {
      reply: execResult.reply,
      stats: execResult.stats,
      workspace: this.ctx.workspace,
      her: {
        dataDir: this.ctx.dataDir,
        workspace: this.ctx.workspace,
        store: {
          active: () => this.ctx.memory.active(),
          count: () => this.ctx.memory.count(),
          get: (id) => this.ctx.memory.get(id),
          markUsed: () => {}
        },
        events: {
          all: () => this.ctx.memory.events || []
        }
      }
    });
    const failed = results.filter((r) => !r.ok);
    const total = results.length || 1;
    const score = Math.round(((total - failed.length) / total) * 100) / 100;
    return {
      role: 'inspector',
      task_id: job.id,
      round: job.rework_round || 0,
      pass: failed.length === 0 && !execResult.error,
      score,
      checks: results,
      failed: failed.map((f) => f.type + '：' + f.detail),
      reason: failed.length ? failed.map((f) => f.detail).join('；') : (execResult.error || ''),
      ts: nowIso()
    };
  }
}

module.exports = { Inspector };
