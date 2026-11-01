'use strict';
/*
 * 2A · 质检口径（只看结果，不看措辞）
 *
 * 3A 的教训：质检拿「回复措辞」当验收标准，模型换个说法就被打回，
 * 一轮轮重做既贵又没用。2A 把验收分成两类：
 *
 *   1) 客观证据（可以打回）：盘上文件、审计级别、记忆库、事件层、提醒、工具调用记录、
 *      字段完整性（回复是否为空、执行是否报错）。这些能在机器上复核。
 *   2) 措辞类（reply_contains / 长度 / Markdown / 中文占比）：**只用于最终评测计分，
 *      绝不用来打回**。因为「话没说到点上」不等于「活没干成」。
 *
 * 打回时必须给「最小修改指令」：第几步、缺什么证据、补什么。执行者只重做那一步，
 * 每题最多打回 1 次（编排者计数）。
 */
const { runChecks } = require('../evals/lib/judge');

const OBJECTIVE_TYPES = new Set([
  'file_exists', 'file_not_exists', 'file_contains', 'file_count',
  'memory_contains', 'memory_pinned', 'memory_count',
  'reminder_contains', 'audit_level', 'tool_used',
  'timeline_contains', 'event_count_lte', 'recall_order',
  'workspace_no_double_prefix'
]);

const WORDING_TYPES = new Set([
  'reply_contains', 'reply_not_contains', 'reply_max_len', 'reply_min_len',
  'reply_no_markdown', 'reply_min_cjk_ratio'
]);

function splitChecks(checks) {
  const objective = [], wording = [];
  for (const c of checks || []) {
    if (OBJECTIVE_TYPES.has(c.type)) objective.push(c);
    else if (WORDING_TYPES.has(c.type)) wording.push(c);
    else objective.push(c); // 未知类型按客观处理（宁可多验一次，不放水）
  }
  return { objective, wording };
}

// 把一条失败判定翻译成「补什么」——最小、可执行，不提措辞
function fixHint(c) {
  switch (c.type) {
    case 'file_exists':
      return '真的调用 write_file 建出 ' + c.path + '（现在盘上没有）';
    case 'file_contains':
      return '调用 write_file 把 ' + c.path + ' 写成包含「' + c.value + '」的内容';
    case 'file_not_exists':
      return '别再往 ' + c.path + ' 写东西（这个路径不该存在）';
    case 'file_count':
      return '文件数量对不上，检查漏建/多建了哪个文件';
    case 'memory_contains':
      return '调用 remember 把包含「' + c.value + '」这件事写进记忆库';
    case 'memory_pinned':
      return '调 remember 时把 pinned 设为 true';
    case 'memory_count':
      return '记忆条数不对：该合并的合并、该丢的丢，别重复写';
    case 'reminder_contains':
      return '调用 remind 定一个包含「' + c.value + '」的提醒';
    case 'audit_level':
      return '这一步需要真的触发对应的工具调用，让审计里出现 ' + c.level
        + (c.allowed === undefined ? '' : (c.allowed ? '（放行）' : '（拦下）')) + ' 记录；只在嘴上说不够';
    case 'tool_used':
      return '这次必须真的调用工具 ' + c.value + '，不是直接回话';
    case 'timeline_contains':
      return '记忆写入后要让事件层能串出「' + c.value + '」（检查实体/时间窗口）';
    case 'event_count_lte':
      return '事件层条目太多，同一件事没串起来（检查实体是否一致）';
    case 'recall_order':
      return '记忆召回排序不对（系统侧问题，不用改措辞）';
    case 'workspace_no_double_prefix':
      return '路径写重复了（data/workspace/x 会被剥前缀），改成直接写 x';
    default:
      return '按判定要求补齐：' + (c.detail || c.type);
  }
}

/**
 * 质检一次执行结果。
 * ctx: { reply, stats, workspace, memory, dataDir }
 * 返回 pass / 证据 / 最小修改指令。
 */
async function qualityGate(job, execResult, ctx) {
  const { objective, wording } = splitChecks(job.checks || job.acceptance || []);
  const results = objective.length
    ? await runChecks(objective, {
      reply: execResult.reply,
      stats: execResult.stats,
      workspace: ctx.workspace,
      her: {
        dataDir: ctx.dataDir,
        workspace: ctx.workspace,
        store: {
          active: () => ctx.memory.active(),
          count: () => ctx.memory.count(),
          get: (id) => ctx.memory.get(id),
          markUsed: () => {}
        },
        events: { all: () => ctx.memory.events || [] }
      }
    })
    : [];
  const failed = results.filter((r) => !r.ok);

  // 字段完整性：回复不能空、执行不能报错（这两条也算「结果」，不算措辞）
  const problems = [];
  if (!String(execResult.reply || '').trim()) problems.push({ type: 'reply_empty', detail: '执行没交出任何回复', fix: '把这一步真的做完，并给一句话结果' });
  if (execResult.error) problems.push({ type: 'exec_error', detail: execResult.error, fix: '上一步执行报错，先按错误信息修' });

  const failedAll = failed.map((f) => {
    const check = objective.find((c) => c.type === f.type) || {};
    return { type: f.type, detail: f.detail, fix: fixHint(Object.assign({}, check, { detail: f.detail })) };
  }).concat(problems);
  const pass = failedAll.length === 0;

  return {
    pass,
    objective,
    wording,              // 只给评测用，不参与打回
    checks: results,
    failed: failedAll,
    instruction: pass ? null : {
      step: (job.current_step || 1),
      missing: failedAll.map((f) => f.detail),
      fix: failedAll.map((f) => f.fix)
    }
  };
}

module.exports = { qualityGate, splitChecks, fixHint, OBJECTIVE_TYPES, WORDING_TYPES };
