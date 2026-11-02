'use strict';
/*
 * 记忆模型测试：从记忆服务搬过来的三条规矩（不合并库，只搬模式）
 *
 *   node evals/memory-model-test.js
 *
 *   1) 层级：钉住/极重要 = core；关系 = relation；其余 = cue
 *   2) 冲突：同一件事「用户说的」和「他说的」只留前者，别两条打架
 *   3) 归属：每条都记是谁的事（默认 owner）
 *   4) 检索：cue 平时不注入，问得准才想起；scope=all 时全给
 */
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/memory/store');
const { recall } = require('../src/memory/retrieve');
const { classify, scoreImportance, isEmotional } = require('../src/memory/classify');

const TMP = path.join(__dirname, '.run', 'memory-model');
let fails = 0;
function ok(name, cond, extra) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(extra === undefined ? '' : extra)));
  if (!cond) fails++;
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const store = new Store(path.join(TMP, 'memory'));

  const core = store.add({ text: '用户叫小王', kind: 'fact', importance: 4, pinned: true });
  const rel = store.add({ text: '用户养了一只猫', kind: 'relation', importance: 2 });
  const cue = store.add({ text: '用户昨天说想吃火锅', kind: 'fact', importance: 1 });

  ok('钉住/高重要 → core', core.tier === 'core', core.tier);
  ok('关系类 → relation', rel.tier === 'relation', rel.tier);
  ok('普通事实 → cue', cue.tier === 'cue', cue.tier);
  ok('默认归属 owner', core.person === 'owner', core.person);

  // 冲突：先存「他喜欢冰美式」，再存「用户喜欢冰美式」→ 只留用户那条
  const a = store.add({ text: '他喜欢喝冰美式，不加糖', kind: 'preference', importance: 2, source: 'distill' });
  const b = store.add({ text: '用户喜欢喝冰美式，不加糖', kind: 'preference', importance: 2, source: 'chat' });
  const actives = store.active().filter((x) => /冰美式/.test(x.text));
  ok('同义不同主语只留一条', actives.length === 1, actives.map((x) => x.text));
  ok('留下的是「用户」那条', /^用户/.test(actives[0].text), actives[0] && actives[0].text);

  // 检索分层
  const shallow = await recall(store, '今天天气怎么样', { topK: 5 });
  ok('cue 平时不冒出来（不相关的话不触发）', shallow.hits.filter((h) => /火锅/.test(h.text)).length === 0, shallow.block);
  const exact = await recall(store, '火锅', { topK: 5 });
  ok('问得准了 cue 能想起来', exact.hits.filter((h) => /火锅/.test(h.text)).length === 1, exact.block);
  const deep = await recall(store, '火锅', { topK: 5, scope: 'all' });
  ok('scope=all 时全给', deep.hits.filter((h) => /火锅/.test(h.text)).length === 1, deep.block);
  const coreQ = await recall(store, '我叫什么', { topK: 5 });
  ok('core 平时就在', coreQ.hits.some((h) => /小王/.test(h.text)), coreQ.block);

  // 自动判类 / 重要度（从记忆服务搬的规则）
  ok('喜欢 → preference', classify('用户喜欢喝冰美式') === 'preference', classify('用户喜欢喝冰美式'));
  ok('生日约定 → relation', classify('他的生日是十月二十五') === 'relation', classify('他的生日是十月二十五'));
  ok('教训 → lesson', classify('以后别在高峰期跑大任务') === 'lesson', classify('以后别在高峰期跑大任务'));
  ok('情绪 → emotional', classify('我今天有点累') === 'emotional', classify('我今天有点累'));
  ok('约定类重要度 4', scoreImportance('约定每周三晚上打球') === 4, scoreImportance('约定每周三晚上打球'));
  ok('自动捕获封顶 3', scoreImportance('用户喜欢喝冰美式', 'auto-capture') <= 3, scoreImportance('用户喜欢喝冰美式', 'auto-capture'));

  console.log(fails ? ('失败 ' + fails + ' 条') : '全部通过（9 条）');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FAIL ' + e.message); process.exit(1); });
