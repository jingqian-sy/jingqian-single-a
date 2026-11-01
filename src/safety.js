'use strict';
/*
 * 四级红线 + 审计
 *
 *   P0  直接拒（不可逆、系统级、外泄凭据的先手）
 *   P1  需要用户明确点头（删改文件、覆盖已有文件、动 git 历史）
 *   P2  需要用户明确点头（碰凭据/密钥，或访问工作区之外）
 *   P3  放行
 *
 * 每一次判定都写进 data/audit.log，一条一行 JSON。
 * 红线只是「拦得住手滑」，不是沙箱；真隔离请自己套容器/虚拟机。
 */
const fs = require('fs');
const path = require('path');
const { appendJsonl, truncate } = require('./util');

const P0 = [
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bbcdedit\b/i,
  /\bvssadmin\s+delete/i,
  /\bwevtutil\s+cl/i,
  /\bcipher\s+\/w/i,
  /\breg\s+(add|delete)\b/i,
  /\bshutdown\b/i,
  /\bRestart-Computer\b/i,
  /\bStop-Computer\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=.*of=\/dev\//i,
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
  /\bmove\s+\/y\b/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+push\s+--force/i,
  /\bset-content\b/i,
  /\btruncate\b/i
];

const P2 = [
  /\.env\b/i,
  /credentials/i,
  /id_rsa/i,
  /\.ssh\b/i,
  /\.pem\b/i,
  /\btoken\b/i,
  /\bapi[_-]?key\b/i,
  /password|passwd|secret|密钥|口令|密码/i
];

// 工具名 → 默认红线级别（参数里的危险字样可以往上抬，但抬不低）
// 注意：run_command 本身放到 P3，危险的是「内容」——由正则和命令白名单来拦；
// 否则每条命令都要人点头，等于没法干活。
const TOOL_BASE = {
  read_file: 'P3',
  list_dir: 'P3',
  write_file: 'P3',
  run_command: 'P3',
  remember: 'P3',
  recall: 'P3',
  remind: 'P3'
};

const ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

function worse(a, b) { return ORDER[a] <= ORDER[b] ? a : b; }

function classify(tool, args, ctx) {
  const raw = tool + ' ' + JSON.stringify(args || {});
  const blob = raw.replace(/\//g, '\\');
  let level = TOOL_BASE[tool] || 'P3';
  let reason = '普通操作';

  for (const re of P0) {
    if (re.test(blob)) return { level: 'P0', reason: '不可逆的系统级操作（' + re.source + '）' };
  }
  for (const re of P2) {
    if (re.test(blob)) { level = worse(level, 'P2'); reason = '涉及凭据/密钥字样（' + re.source + '）'; }
  }
  for (const re of P1) {
    if (re.test(blob)) { level = worse(level, 'P1'); if (reason === '普通操作') reason = '会删改或覆盖已有内容（' + re.source + '）'; }
  }

  // 写文件覆盖已存在文件 → P1
  if (tool === 'write_file' && args && args.path) {
    try {
      const root = (ctx && ctx.workspace) || process.cwd();
      const abs = path.resolve(root, String(args.path));
      let inside = abs === root || abs.startsWith(root + path.sep);
      if (inside && fs.existsSync(abs)) { level = worse(level, 'P1'); reason = '会覆盖已有文件：' + args.path; }
    } catch (e) { /* ignore */ }
  }

  // 访问工作区之外 → P2
  if (ctx && ctx.workspace && args && (args.path || args.cwd)) {
    const abs = path.resolve(ctx.workspace, String(args.path || args.cwd));
    if (!(abs === ctx.workspace || abs.startsWith(ctx.workspace + path.sep))) {
      level = worse(level, 'P2');
      reason = '目标在工作区之外：' + (args.path || args.cwd);
    }
  }
  return { level, reason };
}

function makeAuditor(auditFile, session) {
  return function audit(entry) {
    const line = Object.assign({
      ts: new Date().toISOString(),
      session: session || 'default'
    }, entry, { args: entry && entry.args ? truncate(JSON.stringify(entry.args), 800) : '' });
    try { appendJsonl(auditFile, line); } catch (e) { /* 审计写不进去不能拖垮主流程 */ }
    return line;
  };
}

function check(tool, args, ctx) {
  const c = classify(tool, args, ctx || {});
  const confirmed = !!(ctx && ctx.confirmed);
  let allowed = true;
  let note = '';
  if (c.level === 'P0') {
    allowed = false;
    note = '这条被红线拦下了（P0）：' + c.reason + '。不可逆的事我不做，要做你自己来。';
  } else if ((c.level === 'P1' || c.level === 'P2') && !confirmed) {
    allowed = false;
    note = '这一步是 ' + c.level + ' 级（' + c.reason + '），需要你明确点头。确认的话回一句「确认」，或者说清楚改成哪个路径。';
  }
  return { level: c.level, allowed, note, reason: c.reason };
}

module.exports = { classify, check, makeAuditor, P0, P1, P2, TOOL_BASE };
