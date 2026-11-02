'use strict';
/*
 * 从私有版迁来的功能工具测试（不联网、不动鼠标）：
 *   1) 四个工具都在工具箱里（tentacle / speak / local_ask / sub_agent）；
 *   2) config.features 关掉哪个，工具箱里就没哪个；
 *   3) 触手会动系统的动作（click/type/key/web_click…）至少 P1，必须用户点头；只看不动的（shot）是 P3；
 *   4) 不认识的触手动作明确回一句，不瞎跑；
 *   5) 子智能体没接回调时给一句人话，不抛异常。
 *
 *   node evals/extras-test.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { Tools } = require(path.join(ROOT, 'src', 'tools'));
const safety = require(path.join(ROOT, 'src', 'safety'));

const TMP = path.join(__dirname, '.run', 'extras-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, 'workspace'), { recursive: true });

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '：' + detail : '')); }
}

function makeTools(features) {
  const cfg = {
    features: features || {},
    tools: { workspace: 'workspace', allowCommand: true, commandWhitelist: ['echo'], names: null },
    localModel: { base: 'http://127.0.0.1:11434', models: { '8b': 'qwen3:8b' } }
  };
  return new Tools({
    cfg,
    root: ROOT,
    workspace: path.join(TMP, 'workspace'),
    store: { add() { return {}; }, active() { return []; }, count() { return 0; } },
    events: { all() { return []; }, block() { return ''; } },
    audit: () => ({}),
    dataDir: TMP
  });
}

(async () => {
  const tools = makeTools();
  const names = tools.defs().map((d) => d.function.name);
  ok(['tentacle', 'speak', 'local_ask', 'sub_agent'].every((n) => names.includes(n)), '四个迁移工具都在工具箱里', names.join(','));

  const off = makeTools({ tentacle: false }).defs().map((d) => d.function.name);
  ok(!off.includes('tentacle'), 'features.tentacle=false 时触手不出现');
  ok(off.includes('speak'), '关掉触手不影响别的工具');

  const click = safety.check('tentacle', { action: 'click', x: 1, y: 2 }, {});
  ok(click.level === 'P1' && click.allowed === false, '触手 click 是 P1（要先点头）', JSON.stringify(click));
  const type = safety.check('tentacle', { action: 'type', text: 'hi' }, {});
  ok(type.level === 'P1', '触手 type 是 P1');
  const shot = safety.check('tentacle', { action: 'shot' }, {});
  ok(shot.level === 'P3' && shot.allowed === true, '触手 shot 只看不动，放行');

  const weird = await tools.run('tentacle', { action: 'nonsense' }, {});
  ok(/不认识这个动作/.test(String(weird)), '不认识的触手动作明确回绝', String(weird));

  const sub = await tools.run('sub_agent', { task: '随便说一句' }, {});
  ok(/没接上/.test(String(sub)), '子智能体没接回调时给一句人话', String(sub));

  console.log('\n迁移工具用例：' + pass + '/' + (pass + fail) + ' 通过');
  if (fail) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
