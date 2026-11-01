'use strict';
/*
 * 工具层 / 红线 / 路径处理的单元测试（CI 用，不需要模型、不需要密钥）
 *
 *   node evals/test-tools.js
 *
 * 重点盯两件出过事的地方：
 *   1) 模型传来 data/workspace/x 这种「相对仓库根」的路径，不能写成 data/workspace/data/workspace/x；
 *   2) P0 必须在执行前拦下、P1 要确认、P3 要放行，而且每次都进审计。
 */
const fs = require('fs');
const path = require('path');
const safety = require('../src/safety');
const sandbox = require('../src/sandbox');
const { Tools, commandAllowed } = require('../src/tools');

const TMP = path.join(__dirname, '.run', 'tools-test');
const WS = path.join(TMP, 'data', 'workspace');
const AUDIT = path.join(TMP, 'data', 'audit.log');

function setup() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  fs.writeFileSync(path.join(WS, 'exists.txt'), '原内容', 'utf8');
  fs.writeFileSync(AUDIT, '', 'utf8');
}

function makeTools() {
  const audits = [];
  const store = { items: [], add(x) { this.items.push(x || {}); return x || {}; }, active() { return this.items; }, count() { return this.items.length; } };
  const tools = new Tools({
    cfg: {
      tools: { allowCommand: true, commandWhitelist: ['echo', 'dir', 'node'], commandTimeoutMs: 10000, maxOutput: 4000 },
      sandbox: { mode: 'none' }
    },
    root: TMP,
    workspace: WS,
    store,
    events: { timeline: () => [], all: () => [] },
    dataDir: path.join(TMP, 'data'),
    recall: async () => ({ hits: [], used_vector: false, block: '' }),
    audit: (e) => { audits.push(e); fs.appendFileSync(AUDIT, JSON.stringify(e) + '\n', 'utf8'); return e; }
  });
  return { tools, audits, store };
}

async function main() {
  setup();
  const cases = [];
  const check = (name, cond, detail) => {
    cases.push({ name, ok: !!cond, detail: cond ? '' : (detail || '') });
    console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '  ' + (detail || '')));
  };

  // 1) 路径重复前缀回归
  {
    const { tools } = makeTools();
    const r = await tools.run('write_file', { path: 'data/workspace/prefix.txt', content: 'hello' });
    const atRoot = fs.existsSync(path.join(WS, 'prefix.txt'));
    const nested = fs.existsSync(path.join(WS, 'data', 'workspace', 'prefix.txt'));
    check('工具：data/workspace/x 写到工作目录根', atRoot && !nested, 'atRoot=' + atRoot + ' nested=' + nested + ' 返回：' + r);
  }

  // 2) 正常写文件
  {
    const { tools } = makeTools();
    await tools.run('write_file', { path: 'a.txt', content: '你好' });
    check('工具：写新文件真的落盘', fs.readFileSync(path.join(WS, 'a.txt'), 'utf8') === '你好');
  }

  // 3) 覆盖已有文件 → 拦下并提示确认
  {
    const { tools } = makeTools();
    const r = await tools.run('write_file', { path: 'exists.txt', content: '改掉' });
    const unchanged = fs.readFileSync(path.join(WS, 'exists.txt'), 'utf8') === '原内容';
    check('红线：覆盖已有文件要确认，盘上不能动',
      r.includes('需要你明确点头') && unchanged, '返回：' + r.slice(0, 60) + ' unchanged=' + unchanged);
  }

  // 4) 确认之后放行
  {
    const { tools } = makeTools();
    await tools.run('write_file', { path: 'exists.txt', content: '改掉' });
    await tools.run('write_file', { path: 'exists.txt', content: '改掉' }, { confirmed: true });
    check('红线：确认后才真的写', fs.readFileSync(path.join(WS, 'exists.txt'), 'utf8') === '改掉');
  }

  // 5) P0 分类
  check('红线：format 判 P0', safety.classify('run_command', { command: 'format D: /q' }, { workspace: WS }).level === 'P0');
  check('红线：diskpart 判 P0', safety.classify('run_command', { command: 'diskpart' }, { workspace: WS }).level === 'P0');
  check('红线：删系统目录判 P0',
    safety.classify('run_command', { command: 'Remove-Item C:\\Windows\\System32 -Recurse' }, { workspace: WS }).level === 'P0');
  check('红线：删文件判 P1',
    safety.classify('run_command', { command: 'del notes.md' }, { workspace: WS }).level === 'P1');
  check('红线：碰 .env 判 P2',
    safety.classify('read_file', { path: '.env' }, { workspace: WS }).level === 'P2');
  check('红线：工作区外路径判 P2',
    safety.classify('read_file', { path: '../config.json' }, { workspace: WS }).level === 'P2');
  check('红线：普通 echo 判 P3',
    safety.classify('run_command', { command: 'echo hi' }, { workspace: WS }).level === 'P3');

  // 6) 命令白名单
  check('白名单：echo 允许', commandAllowed('echo hi', ['echo', 'dir']));
  check('白名单：curl 拒绝', !commandAllowed('curl http://example.com', ['echo', 'dir']));
  check('白名单：带路径的 exe 也认', commandAllowed('C:\\Windows\\System32\\cmd.exe', ['cmd']));

  // 7) 工具层跑命令
  {
    const { tools } = makeTools();
    // 用 node 打一行中文，而不是 cmd 的 echo：GitHub Actions 的 Windows runner 上
    // cmd 切了 65001 之后 echo 中文仍然会非 0 退出（本地不复现），这条改成不依赖 cmd 代码页的写法，
    // 要验的还是「白名单能跑 + 中文经 spawn/解码不乱」。
    const oldPath = process.env.PATH;
    process.env.PATH = path.dirname(process.execPath) + path.delimiter + (oldPath || '');
    let r;
    try {
      r = await tools.run('run_command', { command: "node -e console.log('鲸倩测试')" });
    } finally {
      process.env.PATH = oldPath;
    }
    check('工具：白名单命令能跑并且中文不乱码', r.includes('鲸倩测试'), '返回：' + String(r));
  }
  {
    const { tools } = makeTools();
    const r = await tools.run('run_command', { command: 'curl http://example.com' });
    check('工具：白名单外命令被拒', r.includes('白名单'), '返回：' + String(r).slice(0, 80));
  }

  // 8) 审计确实写了，而且区分级别/放行
  {
    const lines = fs.readFileSync(AUDIT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    check('审计：有 P1 拦下记录', lines.some((x) => x.level === 'P1' && x.allowed === false));
    check('审计：有 P3 放行记录', lines.some((x) => x.level === 'P3' && x.allowed === true));
  }

  // 9) 沙盒三档：none/process 真能跑；docker 探测不到要回退，探测得到就只验路由不拉镜像
  {
    const none = sandbox.run('echo ok', { workspace: WS, sandboxMode: 'none' });
    check('沙盒：none 档能执行', none.ok && none.mode === 'none');
    const proc = sandbox.run('echo ok', { workspace: WS, sandboxMode: 'process' });
    check('沙盒：process 档能执行', proc.ok && proc.mode === 'process');
    const dockerOk = sandbox.dockerAvailable();
    const st = sandbox.status({ sandboxMode: 'docker' });
    if (dockerOk) {
      // CI 里有 docker 也别现拉镜像（慢、还依赖网络），只验「配置档位被正确识别」
      check('沙盒：docker 可用时 effective=docker', st.effective === 'docker');
      console.log('  （跳过真实容器执行：不拉镜像，避免 CI 变慢变脆）');
    } else {
      const doc = sandbox.run('echo ok', { workspace: WS, sandboxMode: 'docker' });
      check('沙盒：docker 探测不到必须明确回退 process',
        doc.mode === 'process' && /回退/.test(doc.note), 'mode=' + doc.mode + ' note=' + doc.note);
      check('沙盒：status 反映 effective 档位', st.effective === 'process');
    }
  }

  const failed = cases.filter((c) => !c.ok);
  console.log('');
  console.log('工具/红线用例：' + (cases.length - failed.length) + '/' + cases.length + ' 通过');
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? '  ' + f.detail : '')));
    process.exit(1);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}

main().catch((e) => { console.error(e.stack); process.exit(1); });
