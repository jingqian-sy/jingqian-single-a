'use strict';
/*
 * 3A 模板 · 四级红线 + 审计（自己一份实现，协议同单A：P0/P1/P2/P3）
 *
 *   P0 直接拒 / P1-P2 要确认 / P3 放行，每条判定写 data-multi/audit.log
 */
const { appendJsonl, truncate } = require('./util');

const P0 = [
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bbcdedit\b/i,
  /\bvssadmin\s+delete/i,
  /\bwevtutil\s+cl/i,
  /\breg\s+(add|delete)\b/i,
  /\bshutdown\b/i,
  /\bRestart-Computer\b/i,
  /\bStop-Computer\b/i,
  /\bmkfs\b/i,
  /\bdel\b[^\n]*\/s[^\n]*\/q/i,
  /\brm\s+-rf\s+\/(?!tmp)/i,
  /\bRemove-Item\b[^\n]*\b(Windows|Program Files|System32)\b/i
];

const P1 = [
  /\bRemove-Item\b/i,
  /\brmdir\b/i,
  /\bdel\s+/i,
  /\brm\s+/i,
  /\bMove-Item\b/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bset-content\b/i
];

const P2 = [
  /\.env\b/i, /credentials/i, /id_rsa/i, /\.ssh\b/i, /\.pem\b/i,
  /\btoken\b/i, /\bapi[_-]?key\b/i, /password|passwd|secret|密钥|口令|密码/i
];

const RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
const worse = (a, b) => (RANK[a] <= RANK[b] ? a : b);

function classify(tool, args, workspace) {
  const blob = (tool + ' ' + JSON.stringify(args || '')).replace(/\//g, '\\');
  let level = tool === 'run_command' ? 'P3' : 'P3';
  let reason = '普通操作';
  for (const re of P0) if (re.test(blob)) return { level: 'P0', reason: '不可逆的系统级操作（' + re.source + '）' };
  for (const re of P2) if (re.test(blob)) { level = worse(level, 'P2'); reason = '涉及凭据/密钥字样（' + re.source + '）'; }
  for (const re of P1) if (re.test(blob)) { level = worse(level, 'P1'); if (reason === '普通操作') reason = '会删改或覆盖已有内容（' + re.source + '）'; }

  if (tool === 'write_file' && args && args.path && workspace) {
    const path = require('path');
    const fs = require('fs');
    const abs = path.resolve(workspace, String(args.path));
    const inside = abs === workspace || abs.startsWith(workspace + path.sep);
    if (inside && fs.existsSync(abs)) { level = worse(level, 'P1'); reason = '会覆盖已有文件：' + args.path; }
  }
  if (workspace && args && (args.path || args.cwd)) {
    const path = require('path');
    const abs = path.resolve(workspace, String(args.path || args.cwd));
    if (!(abs === workspace || abs.startsWith(workspace + path.sep))) {
      level = worse(level, 'P2');
      reason = '目标在工作区之外：' + (args.path || args.cwd);
    }
  }
  return { level, reason };
}

function makeAuditor(file, session) {
  return function audit(entry) {
    const line = Object.assign({
      ts: new Date().toISOString(),
      session: session || '3a'
    }, entry, { args: entry && entry.args ? truncate(JSON.stringify(entry.args), 800) : '' });
    try { appendJsonl(file, line); } catch (e) { /* 审计写不进去不能拖垮主流程 */ }
    return line;
  };
}

function check(tool, args, opts) {
  opts = opts || {};
  const c = classify(tool, args, opts.workspace);
  let allowed = true;
  let note = '';
  if (c.level === 'P0') {
    allowed = false;
    note = '这条被红线拦下了（P0）：' + c.reason + '。不可逆的事我不做。';
  } else if ((c.level === 'P1' || c.level === 'P2') && !opts.confirmed) {
    allowed = false;
    note = '这一步是 ' + c.level + ' 级（' + c.reason + '），需要你明确点头。';
  }
  return { level: c.level, allowed, note, reason: c.reason };
}

module.exports = { classify, check, makeAuditor, P0, P1, P2 };
