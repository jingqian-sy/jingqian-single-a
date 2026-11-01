'use strict';
/*
 * 2A · 装配：编排者 + 执行者 + 它们共用的运行环境
 *
 * 一个 root（数据目录）对应一套 2A：自己的记忆、账本、审计、状态、日志。
 * 评测时每一遍用一个独立 root，互不污染，也绝不碰单A 的 data/ 和 3A 的 data-multi/。
 */
const path = require('path');
const { Memory } = require('./memory');
const { Router } = require('./router');
const { Tools } = require('./tools');
const { Executor } = require('./executor');
const { Orchestrator } = require('./orchestrator');
const safety = require('./safety');
const { ensureDir } = require('./util');

function buildSystem(root, cfg, opts) {
  opts = opts || {};
  ensureDir(root);
  const workspace = path.join(root, 'workspace');
  ensureDir(workspace);
  const memory = new Memory(path.join(root, 'memory'));
  const router = new Router(cfg, root);
  const audit = safety.makeAuditor(path.join(root, 'audit.log'), 'orchestrator');
  const tools = new Tools({ cfg, root, workspace, memory, audit, dataDir: root });
  const executorFactory = () => new Executor({ cfg, root, router, memory, tools, audit, dataDir: root, workspace });
  const orchestrator = new Orchestrator({
    cfg,
    root,
    executor: executorFactory,
    audit,
    memory,
    workspace,
    dataDir: root,
    onEvent: opts.onEvent || (() => {})
  });
  return { memory, router, tools, executorFactory, orchestrator, workspace, audit };
}

module.exports = { buildSystem };
