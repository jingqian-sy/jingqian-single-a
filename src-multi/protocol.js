'use strict';
/*
 * 3A 协议层：消息信封 + 任务状态机定义 + 校验
 *
 * 这是「共用协议」里最硬的一条：跨角色只认 JSON 信封，字段一个不能少，
 * 写入前先过 validateEnvelope()，不合格直接拒收并记 rejected.log。
 *
 * 信封字段（与单A/3A 共用）：
 *   id          信封自己的 id
 *   from        谁发的：scheduler | executor | inspector | human
 *   to          给谁
 *   task_id     任务号
 *   status      状态：planned | dispatched | completed | failed | rework | escalated | done
 *   payload     载荷（对象，具体 schema 由 status 决定）
 *   ts          发出时间（ISO）
 *   depends_on  依赖的任务号数组（可以为空）
 */
const { nowIso, uid } = require('./util');

const ROLES = ['scheduler', 'executor', 'inspector', 'human'];
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
  for (const f of ENVELOPE_FIELDS) {
    if (!(f in e)) errors.push('缺字段 ' + f);
  }
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

// 任务状态机：调度是唯一写者，所以合法迁移只在这里定义一次
const TASK_STATES = ['pending', 'planned', 'running', 'inspecting', 'rework', 'done', 'failed', 'escalated'];
const TRANSITIONS = {
  pending: ['planned', 'failed'],
  planned: ['running', 'failed'],
  // running → planned 是「执行出错后重试一次」的合法回退（重试上限 1 次，调度记 journal）
  running: ['inspecting', 'planned', 'failed'],
  inspecting: ['done', 'rework', 'escalated', 'failed'],
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
