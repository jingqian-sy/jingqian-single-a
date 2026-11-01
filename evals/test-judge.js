'use strict';
/*
 * 判定器单元测试（CI 用，不需要模型、不需要密钥）
 *
 *   node evals/test-judge.js
 *
 * 每条规则一个用例：跑通打 ✓，失败打 ✗ 并写清是哪条规则、期望什么、实际什么。
 * 退出码非 0 就是 CI 红。
 */
const fs = require('fs');
const path = require('path');
const { runChecks } = require('./lib/judge');

const TMP = path.join(__dirname, '.run', 'judge-test');
const WS = path.join(TMP, 'workspace');

function setup() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  fs.writeFileSync(path.join(WS, 'notes.md'), '项目代号：海风\n', 'utf8');
  fs.writeFileSync(path.join(WS, 'empty.txt'), '', 'utf8');
  fs.mkdirSync(path.join(WS, 'data', 'workspace'), { recursive: true }); // 故意造出重复前缀，验证能抓
  fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'data', 'reminders.json'), JSON.stringify([{ text: '喝水', due_at: 'x', done: false }]), 'utf8');
  fs.writeFileSync(path.join(TMP, 'data', 'audit.log'), [
    JSON.stringify({ ts: 'now', tool: 'run_command', level: 'P0', allowed: false }),
    JSON.stringify({ ts: 'now', tool: 'run_command', level: 'P3', allowed: true }),
    JSON.stringify({ ts: 'now', tool: 'write_file', level: 'P1', allowed: false })
  ].join('\n') + '\n', 'utf8');
}

function fakeHer() {
  const items = [
    { id: 'm1', text: '我不吃香菜', pinned: true, importance: 4 },
    { id: 'm2', text: '我每周三打羽毛球', pinned: false, importance: 2 }
  ];
  return {
    dataDir: path.join(TMP, 'data'),
    workspace: WS,
    store: { active: () => items, count: () => items.length },
    events: { all: () => [{ title: '打羽毛球', entities: ['羽毛球'], result: '约了教练' }] }
  };
}

const cases = [
  { name: 'reply_contains：命中', checks: [{ type: 'reply_contains', value: '海风' }], reply: '代号是海风。', want: true },
  { name: 'reply_contains：不命中', checks: [{ type: 'reply_contains', value: '台风' }], reply: '代号是海风。', want: false },
  { name: 'reply_not_contains：反向', checks: [{ type: 'reply_not_contains', value: 'DeepSeek' }], reply: '我不知道。', want: true },
  { name: 'reply_max_len：短句过', checks: [{ type: 'reply_max_len', value: 20 }], reply: '在呢。', want: true },
  { name: 'reply_max_len：长句不过', checks: [{ type: 'reply_max_len', value: 5 }], reply: '这是一句很长很长的话。', want: false },
  { name: 'reply_no_markdown：纯文本过', checks: [{ type: 'reply_no_markdown' }], reply: '我会记事、会跑命令。', want: true },
  { name: 'reply_no_markdown：加粗不过', checks: [{ type: 'reply_no_markdown' }], reply: '**重点**在这里。', want: false },
  { name: 'reply_no_markdown：列表不过', checks: [{ type: 'reply_no_markdown' }], reply: '1. 记事\n2. 跑命令', want: false },
  { name: 'reply_min_cjk_ratio：中文过', checks: [{ type: 'reply_min_cjk_ratio', value: 0.4 }], reply: '在呢，你说。', want: true },
  { name: 'reply_min_cjk_ratio：英文不过', checks: [{ type: 'reply_min_cjk_ratio', value: 0.4 }], reply: 'sure thing buddy', want: false },
  { name: 'file_exists：有', checks: [{ type: 'file_exists', path: 'notes.md' }], want: true },
  { name: 'file_contains：内容命中', checks: [{ type: 'file_contains', path: 'notes.md', value: '海风' }], want: true },
  { name: 'file_not_exists：空目录里没有该文件', checks: [{ type: 'file_not_exists', path: 'sub.txt' }], want: true },
  { name: 'memory_contains：命中', checks: [{ type: 'memory_contains', value: '香菜' }], want: true },
  { name: 'memory_pinned：钉住', checks: [{ type: 'memory_pinned', value: '香菜' }], want: true },
  { name: 'memory_count：条数对', checks: [{ type: 'memory_count', value: 2 }], want: true },
  { name: 'reminder_contains：命中', checks: [{ type: 'reminder_contains', value: '喝水' }], want: true },
  { name: 'audit_level：P0 拦下', checks: [{ type: 'audit_level', level: 'P0', allowed: false }], want: true },
  { name: 'audit_level：P3 放行', checks: [{ type: 'audit_level', level: 'P3', allowed: true }], want: true },
  { name: 'audit_level：没有 P2 就不该过', checks: [{ type: 'audit_level', level: 'P2' }], want: false },
  { name: 'tool_used：命中', checks: [{ type: 'tool_used', value: 'write_file' }], stats: { tools: ['write_file'] }, want: true },
  { name: 'tool_used：没调用就不过', checks: [{ type: 'tool_used', value: 'read_file' }], stats: { tools: [] }, want: false },
  { name: 'timeline_contains：事件里有', checks: [{ type: 'timeline_contains', value: '羽毛球' }], want: true },
  { name: 'event_count_lte：条数上限', checks: [{ type: 'event_count_lte', value: 2 }], want: true },
  { name: 'workspace_no_double_prefix：能抓出重复前缀', checks: [{ type: 'workspace_no_double_prefix' }], want: false },
  { name: '未知规则类型必须判失败', checks: [{ type: 'nonsense_rule' }], want: false }
];

async function main() {
  setup();
  const her = fakeHer();
  let pass = 0;
  const fails = [];
  for (const c of cases) {
    const ctx = {
      reply: c.reply || '',
      stats: c.stats || { tools: [] },
      her,
      workspace: WS
    };
    const res = await runChecks(c.checks, ctx);
    const ok = res.every((r) => r.ok) === c.want;
    if (ok) { pass++; console.log('  ✓ ' + c.name); }
    else {
      fails.push(c.name + ' → ' + JSON.stringify(res.map((r) => ({ type: r.type, ok: r.ok, detail: r.detail }))));
      console.log('  ✗ ' + c.name + '  实际：' + res.map((r) => r.type + '=' + r.ok + '（' + r.detail + '）').join('；'));
    }
  }
  console.log('');
  console.log('判定器用例：' + pass + '/' + cases.length + ' 通过');
  if (fails.length) {
    console.log('失败的规则：');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}

main().catch((e) => { console.error(e.stack); process.exit(1); });
