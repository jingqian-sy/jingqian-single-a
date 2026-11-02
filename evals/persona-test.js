'use strict';
/*
 * 人称测试（CI 用，不起服务、不联网）
 *
 *   node evals/persona-test.js
 *
 * 验这几件事：
 *   1) 记忆按第三人称存（「用户喜欢…」「老爸喜欢…」），去重和检索才稳；
 *   2) 拿去给模型用时统一换成「他」——**不能换成「你」**：
 *      系统提示里「你」指的是她本人，换成「你」模型会把他的事当成自己的；
 *   3) 人格里写清「他说的我=他」「你=他」，并禁止叫她「用户」；
 *   4) 换人称只改展示层，库里的原文不动。
 */
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/memory/store');
const { recall, forPrompt } = require('../src/memory/retrieve');

const TMP = path.join(__dirname, '.run', 'persona-test');
let fails = 0;

function ok(name, cond, extra) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(extra === undefined ? '' : extra)));
  if (!cond) fails++;
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  ok('「用户」换成「他」', forPrompt('用户喜欢喝冰美式') === '他喜欢喝冰美式', forPrompt('用户喜欢喝冰美式'));
  ok('「用户的」换成「他的」', forPrompt('用户的猫叫团子') === '他的猫叫团子', forPrompt('用户的猫叫团子'));
  ok('「老爸」也换成「他」', forPrompt('老爸最爱冰美式不加糖') === '他最爱冰美式不加糖', forPrompt('老爸最爱冰美式不加糖'));
  ok('不会换成「你」（那样她会当成自己的事）', forPrompt('用户喜欢喝冰美式').indexOf('你') < 0, forPrompt('用户喜欢喝冰美式'));

  const store = new Store(path.join(TMP, 'memory'));
  store.add({ text: '用户叫小王', kind: 'fact', importance: 3, pinned: true });
  store.add({ text: '老爸最爱冰美式不加糖', kind: 'preference', importance: 3 });
  const r = await recall(store, '我叫什么 爱喝什么', { topK: 5 });
  ok('召回块里没有「用户」「老爸」', !/用户|老爸/.test(r.block), r.block);
  ok('召回块里说的是「他」', /他叫小王/.test(r.block) && !/你叫小王/.test(r.block), r.block);
  ok('召回的条数正常', r.hits.length >= 1, r.hits.length);

  const raw = store.active().map((x) => x.text).join('|');
  ok('库里的原文还是第三人称（换人称只发生在展示层）', /用户叫小王/.test(raw) && !/他叫小王/.test(raw), raw);

  const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core.js'), 'utf8');
  ok('人格里禁止称他「用户」', /不许对他说「用户」/.test(coreSrc), 'DEFAULT_PERSONA');
  ok('人格里说清他说的「我」= 他自己', /他打「我喜欢什么」是在说他自己/.test(coreSrc), 'DEFAULT_PERSONA');
  ok('参考记忆块说明「他」指对方', /【参考记忆】.*「他」就是跟你说话的那个人/s.test(coreSrc), 'buildMessages');

  console.log(fails ? ('失败 ' + fails + ' 条') : '全部通过（10 条）');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('FAIL ' + e.message);
  process.exit(1);
});
