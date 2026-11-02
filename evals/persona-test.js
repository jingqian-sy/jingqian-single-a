'use strict';
/*
 * 人称测试（CI 用，不起服务、不联网）
 *
 *   node evals/persona-test.js
 *
 * 验四件事：
 *   1) 记忆按第三人称存（「用户喜欢…」），这样去重和检索才稳；
 *   2) 但发给模型/给工具看的时候必须换成第二人称（「你喜欢…」），
 *      否则小模型会照抄「用户」两个字，或者把他说的事说成自己的；
 *   3) 人格里必须有「不许对他称用户」这条硬规矩；
 *   4) 换人称不能改库里的原文（存进去什么样，库里还是什么样）。
 */
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/memory/store');
const { recall, secondPerson } = require('../src/memory/retrieve');

const TMP = path.join(__dirname, '.run', 'persona-test');
let fails = 0;

function ok(name, cond, extra) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(extra === undefined ? '' : extra)));
  if (!cond) fails++;
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  ok('「用户」换成「你」', secondPerson('用户喜欢喝冰美式') === '你喜欢喝冰美式', secondPerson('用户喜欢喝冰美式'));
  ok('「用户的」换成「你的」', secondPerson('用户的猫叫团子') === '你的猫叫团子', secondPerson('用户的猫叫团子'));
  ok('本来就是第二人称的不动', secondPerson('你喜欢喝冰美式') === '你喜欢喝冰美式', secondPerson('你喜欢喝冰美式'));

  const store = new Store(path.join(TMP, 'memory'));
  store.add({ text: '用户叫小王', kind: 'fact', importance: 3, pinned: true });
  store.add({ text: '用户讨厌香菜', kind: 'preference', importance: 3 });
  const r = await recall(store, '我叫什么 讨厌什么', { topK: 5 });
  ok('召回块换成第二人称（给模型看的那份）', /你叫小王/.test(r.block) && !/用户/.test(r.block), r.block);
  ok('召回的条数正常', r.hits.length >= 1, r.hits.length);

  const raw = store.active().map((x) => x.text).join('|');
  ok('库里的原文还是第三人称（换人称只发生在展示层）', /用户叫小王/.test(raw) && !/你叫小王/.test(raw), raw);

  const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core.js'), 'utf8');
  ok('人格里有「不许对他说用户」这条', /不许对他说「用户」/.test(coreSrc), 'DEFAULT_PERSONA');
  ok('参考记忆块带上了人称说明', /参考记忆】.*「你」都是他/s.test(coreSrc), 'buildMessages');

  console.log(fails ? ('失败 ' + fails + ' 条') : '全部通过（7 条）');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('FAIL ' + e.message);
  process.exit(1);
});
