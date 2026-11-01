'use strict';
/*
 * 3A · 装配三个角色（调度 / 执行 / 质检）和它们共用的运行环境
 *
 * 一个 root（数据目录）对应一套 3A：自己的记忆、账本、审计、状态、日志。
 * 评测时每个「一遍」用一个独立 root，互不污染。
 */
const path = require('path');
const { Memory } = require('./memory');
const { Router } = require('./router');
const { Tools } = require('./tools');
const { Executor } = require('./executor');
const { Inspector } = require('./inspector');
const { Scheduler } = require('./scheduler');
const safety = require('./safety');
const { ensureDir } = require('./util');

function buildSystem(root, cfg, opts) {
  opts = opts || {};
  ensureDir(root);
  const workspace = path.join(root, 'workspace');
  ensureDir(workspace);
  const memory = new Memory(path.join(root, 'memory'));
  const router = new Router(cfg, root);
  const audit = safety.makeAuditor(path.join(root, 'audit.log'), 'scheduler');
  const tools = new Tools({ cfg, root, workspace, memory, audit, dataDir: root });
  const executorFactory = () => new Executor({ cfg, root, router, memory, tools, audit, dataDir: root, workspace });
  const inspector = new Inspector({ workspace, dataDir: root, memory });
  const scheduler = new Scheduler({
    cfg,
    root,
    executor: executorFactory,
    inspector,
    audit,
    onEvent: opts.onEvent || (() => {})
  });
  return { memory, router, tools, executorFactory, inspector, scheduler, workspace, audit };
}

module.exports = { buildSystem };
