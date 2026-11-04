'use strict';
/*
 * 质量闸（2.0）
 *
 * 第一道：引用闸。
 * 大模型最常犯的错不是「不会」，是「说得像真的」——编一个不存在的文件、
 * 一个没发生过的路径。这种错用代码一查就露，不用叫模型。
 *
 * 只查绝对路径（D:\xxx 这种）。相对名字（config.json）太容易误报，不碰。
 * 查出来不改她的答案，只在后面补一句人话——改答案会让她前后矛盾。
 */
const fs = require('fs');

// Windows 绝对路径：盘符开头，后面一路到空白或标点
const ABS_PATH = /[A-Za-z]:\\[^\s，。；、）】"'`|<>*?]+/g;

function absPaths(text) {
  const out = [];
  const s = String(text || '');
  const re = new RegExp(ABS_PATH.source, 'g');
  let m;
  while ((m = re.exec(s)) !== null) {
    const p = m[0].replace(/[。，；、)）\]】"'`]+$/, '');
    if (p.length > 3 && out.indexOf(p) < 0) out.push(p);
  }
  return out;
}

function missingPaths(reply) {
  const bad = [];
  for (const p of absPaths(reply)) {
    try { if (!fs.existsSync(p)) bad.push(p); } catch (e) { bad.push(p); }
  }
  return bad;
}

// 补一句，不偷改答案
function referenceGate(reply) {
  const text = String(reply || '');
  const bad = missingPaths(text);
  if (!bad.length) return { reply: text, flagged: [] };
  const list = bad.slice(0, 3).join('、');
  return {
    reply: text + '\n\n（顺嘴说一句：刚才提到的 ' + list + ' 我这边没找到，可能是我记岔了。）',
    flagged: bad
  };
}

module.exports = { referenceGate, missingPaths, absPaths };
