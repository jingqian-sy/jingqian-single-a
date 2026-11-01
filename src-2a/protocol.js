'use strict';
/*
 * 2A 协议层：两个角色（orchestrator / executor）+ 一个收件人 human
 *
 * 和 3A 的区别：没有 inspector。编排者自己质检，少一次「执行→质检→调度」的传话，
 * 信封从每轮 4 个降到 2 个。协议字段仍是同一套（谁/给谁/任务号/状态/载荷/时间/依赖）。
 */
const { nowIso, uid } = require('./util');

const ROLES = ['orchestrator', 'executor', 'human'];
const STATUSES = ['planned', 'dispatched', 'completed', 'failed', 'rework', 'escalated', 'done'];
const ENVELOPE_FIELDS = ['id', 'from', 'to', 'task_id', 'status', 'payload', 'ts', 'depends_on'];

function makeEnvelope(from, to, taskId, status, payload, dependsOn) {
  return {
    id: uid('env'),
    from,
    to,
    task_id: taskId,
    status,
    payload: payload || {},
    ts: nowIso(),
    depends_on: Array.isArray(dependsOn) ? dependsOn.slice() : []
  };
}

function validateEnvelope(e) {
  const errors = [];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, errors: ['信封不是一个对象'] };
  for (const f of ENVELOPE_FIELDS) if (!(f in e)) errors.push('缺字段 ' + f);
  if (e.from && !ROLES.includes(e.from)) errors.push('from 不是合法角色：' + e.from);
  if (e.to && !ROLES.includes(e.to)) errors.push('to 不是合法角色：' + e.to);
  if (e.status && !STATUSES.includes(e.status)) errors.push('status 不合法：' + e.status);
  if (e.payload !== undefined && (typeof e.payload !== 'object' || e.payload === null || Array.isArray(e.payload))) {
    errors.push('payload 必须是对象');
  }
  if (e.ts && Number.isNaN(Date.parse(e.ts))) errors.push('ts 不是合法时间');
  if (e.depends_on !== undefined && !Array.isArray(e.depends_on)) errors.push('depends_on 必须是数组');
  if (e.id !== undefined && (typeof e.id !== 'string' || !e.id.trim())) errors.push('id 必须是非空字符串');
  if (e.task_id !== undefined && (typeof e.task_id !== 'string' || !e.task_id.trim())) errors.push('task_id 必须是非空字符串');
  return { ok: errors.length === 0, errors };
}

const TASK_STATES = ['pending', 'planned', 'running', 'checking', 'rework', 'done', 'failed', 'escalated'];

// 2A 刻意只允许「打回一次」：checking → rework 只能发生一次（由编排者计数保证）
const TRANSITIONS = {
  pending: ['planned', 'failed'],
  planned: ['running', 'failed'],
  running: ['checking', 'planned', 'failed'],
  checking: ['done', 'rework', 'escalated', 'failed'],
  rework: ['running', 'escalated', 'failed'],
  done: [],
  failed: [],
  escalated: []
};

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

module.exports = {
  ROLES, STATUSES, ENVELOPE_FIELDS, TASK_STATES, TRANSITIONS,
  makeEnvelope, validateEnvelope, canTransition
};
