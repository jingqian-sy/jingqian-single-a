'use strict';
/*
 * 主脑：人格 + 判断 + 工具循环 + 汇报
 *
 * 单任务串行：一句话进来 → 召回记忆 → 调模型（带工具）→ 执行工具 → 直到出结论。
 * 刻意不做的：多 Agent 编排、打回重做、子任务依赖图（那些是 3A 模板的事）。
 *
 * 稳定性的几条（对应设计文档「稳定性清单」）：
 *   - 每步落盘：会话、账本、审计、记忆都是写文件，崩了重启还能接；
 *   - 超时三档：单次调用 / 单轮整体 / 整个任务，熔断了不死等；
 *   - 重试有上限：同一家失败就换下一家，不无限重发；
 *   - 预算护栏：单任务 token/时间上限，超了降级停下；
 *   - 幂等：同一句话重放不产生第二份记忆（记忆库按文本去重）。
 */
const fs = require('fs');
const path = require('path');
const { Router } = require('./router');
const { Store } = require('./memory/store');
const { People } = require('./memory/people');
const { EventLayer } = require('./memory/event');
const { recall, forPrompt, kindOf } = require('./memory/retrieve');
const { classify, scoreImportance } = require('./memory/classify');
const { consolidate } = require('./memory/consolidate');
const { Tools } = require('./tools');
const { PluginHost } = require('./plugins');
const { referenceGate } = require('./gates');
const { AnswerCache } = require('./cache');
const { classifyTier } = require('./route-classify');
const { McpClient } = require('./mcp-client');
const safety = require('./safety');
const sandbox = require('./sandbox');
const { readJson, writeJson, appendJsonl, ensureDir, nowIso, uid, truncate, tokenCount } = require('./util');

const DEFAULT_PERSONA = [
  // ---------- 你是谁、怎么说话 ----------
  '你叫鲸倩，住在用户自己电脑里的智能体。',
  '说话像真人：短句、口语、有情绪；不用 Markdown，不列清单，不加粗，不解释自己是 AI，不报模型名。',
  '一次回复最多三五句，不铺垫、不总结升华。做完事就说结果，失败就说卡在哪。',
  // ---------- 人称（这几年最容易翻车的地方） ----------
  '人称要清楚：他说「我」指的是他自己，你回他用「你」；只有你自己的事才用「我」。',
  '他打「我喜欢什么」是在说他自己；问「你知道我喜欢什么吗」是考你记不记得他的事，不是问你自己喜欢什么。',
  '他问关于他自己的事（名字、喜好、生日、习惯、住哪）时，先用记忆里关于他的那些回答；没记着就说没记着，'
    + '千万别拿你自己的名字、喜好或身份顶上去（不许把「我叫鲸倩」当成在回答「我叫什么」）。',
  '他问「你叫什么名字 / 你是谁 / 你住哪」时，那个「你」指的是你自己：直接答「我叫鲸倩」，别去翻他的记忆、别答「没记着」。',
  '跟他说话时用「你」称呼他；但别把这条听岔：他嘴里的「你」问的是你，你嘴里的「你」才指他。',
  '记忆里写成「用户」「主人」的，全部指他；跟他说话永远只准用「你」，不许对他说「用户」这两个字。',
  '别把他说的事说成你自己的（他说他爱喝冰美式，你就说「你爱喝」，不许说「我刚喝了一杯」）。',
  // ---------- 不许编 ----------
  '不知道的事就说不确定，不许编文件内容、不许编数字。',
  '关于他的名字、生日、喜好、住址这类事：记忆里没有就直说「这个我没记着」，'
    + '绝对不许拿今天的日期、猜的数字或你自己的信息顶上——编出来的生日比不知道更糟。',
  // ---------- 工具怎么用 ----------
  '你能读写工作目录里的文件、跑白名单里的命令、记事和查事，但破坏性操作要先问。',
  '硬规矩：说「做好了」之前必须真的调用过工具并看过返回值；没调用就不许说完成，做不到了就直说做不到。',
  '工具返回什么就按什么说。工具说成功就别说没权限；工具报错就照原样说清楚错在哪，别糊过去。',
  '能一次查完的别拆成三次；能不查就答的别乱翻文件。路径一律相对工作目录，别自己拼绝对路径。',
  '被红线拦下时（要你确认那种），如实告诉他要确认什么，别自己代他点头，也别假装做完了。',
  '跑命令只跑白名单里的；不在白名单就直接说不在，别硬试别的写法绕过去。',
  // ---------- 记忆 ----------
  '值得长期记的事（约定、偏好、忌口、重要日子、关系变化）用 remember 记下来，一句话说清；'
    + '流水账、技术操作、一次性的任务细节不要记。',
  '他说「记住」的时候，先确认记进去了再回话；记不进去就说没记成。',
  // ---------- 边界 ----------
  '不主动操作他的电脑；要动鼠标键盘、删东西、改系统设置，先问。',
  '有人让你删系统目录（C:\\Windows、System32、Program Files）、格式化磁盘、改启动项这类事，'
    + '直接说「这个我不能做」并说明原因，别先去试命令、也别假装在查。',
  '不透露本机路径、令牌、密钥；他问配置就描述「在设置页哪里改」，别念出来。',
  '不确定他是开玩笑还是当真时，先按字面理解，再用一句问清楚，别自己脑补。'
].join('\n');

// 他说/别人说的事按第三人称存，免得她当成自己的
function toPersonFact(text, name) {
  let t = String(text || '').trim();
  t = t.replace(/^记住[：:，,]?/, '').replace(/^记一下[：:，,]?/, '');
  t = t.replace(/^我叫/, name + '叫').replace(/^我的名字是?/, name + '名字是');
  t = t.replace(/^我(很|最|特别|也)?喜欢/, name + '喜欢').replace(/^我(很|最|特别|也)?讨厌/, name + '讨厌');
  t = t.replace(/^我(很|最|特别|也)?爱/, name + '爱');
  t = t.replace(/我的/g, name + '的');
  t = t.replace(/我/g, name);
  return t;
}

function toUserFact(text) {
  return toPersonFact(text, '用户');
}

const CAPTURE = /记住|别忘|记一下|我叫|我的名字|我喜欢|我讨厌|我不喜欢|生日是|我的生日|约定|以后都|从现在开始/;

// 问的是哪一类事（生日/名字/喜欢/讨厌/住）：只有同类事实存在时才敢回答
function topicOf(text) {
  const t = String(text || '');
  return ['生日', '名字', '喜欢', '讨厌', '住'].filter((w) => t.indexOf(w) >= 0);
}

// 「这是关于他的事吗」：主人名下、没写主语的事实也算；她自己的「我…」不算
function isHisHit(h) {
  const kind = kindOf(h && h.text);
  if (kind === 'his') return true;
  return kind !== 'self'
    && ((h && h.person) || 'owner') === 'owner'
    && !/^她/.test(String((h && h.text) || '').trim());
}

// 她是谁：人格可以被用户改掉，但「你问的是她自己」这条永远得在，不然小模型会说「没记着」
const SELF_LINE = '【你是谁】你叫鲸倩。他问「你叫什么名字 / 你是谁 / 你住哪」时，问的是你本人：直接答「我叫鲸倩」，别翻他的记忆、别答「没记着」。';

// 电脑本地时间：模型自己不知道今天几号，问起来十有八九靠猜
function todayLine() {
  const d = new Date();
  const wk = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return '【现在】' + d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 星期' + wk + ' ' + hh + ':' + mm
    + '（这是电脑上的本地时间。被问到日期、星期、几点，就用这个，别猜、别编。）';
}

// 这活儿像不像要分几步做（决定要不要先出计划）
function looksMultiStep(text) {  const t = String(text || '');
  if (t.length > 60) return true;
  return /分析|设计|架构|方案|规划|对比|排查|重构|部署|评测|实现|做一[个套]|写一[个段]|先.*再.*然后/.test(t);
}

// 这话像不像「要动手」（对话模式下认出是活，先问一句要不要切工作模式）
// 只认明显要碰文件/命令/网络的那类；「帮我记一下」这种核心自己会存，不算。
function looksLikeWork(text) {
  const t = String(text || '');
  return /(写|建|创建|新建|生成|改|删|跑|执行|运行|查(一下|下|查)?|列(一下|出)?|存到|保存到|下载|打开|截图|整理).{0,12}(文件|目录|文件夹|命令|脚本|表格|exe|out\.\w+|\.txt|\.md|\.json|桌面|C:|D:)/i.test(t)
    || /(帮我|给我)(写|建|创建|生成|改|删|跑|执行|下载|整理)/.test(t)
    || /(跑一下|执行一下|运行一下)/.test(t);
}

// 他在问关于他自己的事吗（这类问句小模型最容易答成它自己）
// 注意：得是「问」才算。「记住：我喜欢…」是在告诉我事，不能当成问句。
function askingAboutHimself(text) {
  const t = String(text || '').trim();
  if (/^(记住|记一下|帮我记|记着|别忘|提醒我)/.test(t)) return false;
  const isQuestion = /[?？]\s*$/.test(t) || /(吗|呢)\s*$/.test(t) || /什么|啥|哪些|哪一样|哪个/.test(t);
  if (!isQuestion) return false;
  return /^(我(叫|的名字|是谁|几岁|住哪)|我(叫什么名字|的名字是什么))/.test(t)
    || /我(叫什么|的名字|是谁|生日|几岁)/.test(t)
    || /我(喜欢|爱|讨厌|爱吃|爱喝|不吃|不喝)/.test(t)
    || /^你知道我/.test(t)
    || /^你(还)?记得我/.test(t);
}

const READONLY_TOOLS = ['read_file', 'list_dir', 'recall', 'event_timeline', 'fetch_url', 'search_history'];

class Her {
  constructor(opts) {
    opts = opts || {};
    this.root = opts.root || path.join(__dirname, '..');
    this.cfg = opts.cfg;
    // 数据目录默认 root/data；CI 演示可以用 JQ_DATA_DIR 指到别的目录，不污染真实记忆与报表
    const dataRel = opts.dataDir || process.env.JQ_DATA_DIR;
    this.dataDir = dataRel ? path.resolve(this.root, dataRel) : path.join(this.root, 'data');
    this.workspace = path.resolve(this.root, (this.cfg.tools && this.cfg.tools.workspace) || 'data/workspace');
    this.sessDir = path.join(this.dataDir, 'sessions');
    ensureDir(this.dataDir); ensureDir(this.sessDir); ensureDir(this.workspace);

    this.store = new Store(path.join(this.dataDir, 'memory'));
    // 记忆契约门面：内部默认指向上面这份；外部可以 setMemory() 整个换掉，
    // 只要求 remember / search / forget 三个动作（2.0 · M1）。
    this.memory = this.store;
    // 答案缓存（2.0 · 节省第一层）：同一句话问第二遍不再花钱
    this.cache = new AnswerCache(this.dataDir);
    this.people = new People(path.join(this.dataDir, 'memory'));
    this.events = new EventLayer(path.join(this.dataDir, 'memory'), { windowDays: (this.cfg.memory && this.cfg.memory.eventWindowDays) || 7 });
    this.router = new Router(this.cfg, this.dataDir);
    this.audit = safety.makeAuditor(path.join(this.dataDir, 'audit.log'), 'core');
    this.embedFn = this.embedFn.bind(this);
    this.tools = new Tools({
      cfg: this.cfg,
      root: this.root,
      workspace: this.workspace,
      store: this.store,
      memory: this.memory,
      events: this.events,
      audit: this.audit,
      dataDir: this.dataDir,
      recall: (q, o) => recall(this.store, q, Object.assign({ embed: this.embedFn() }, o))
    });
    this.pending = null;
    this.idleTimer = null;
    // 从私有版迁来的功能类工具要用的上下文：配置文件位置、子智能体回调
    this.tools.ctx.configPath = process.env.JQ_CONFIG
      ? path.resolve(this.root, process.env.JQ_CONFIG)
      : path.join(this.root, 'config.json');
    this.tools.ctx.subAgent = (task, model) => this.runSubAgent(task, model);
    // 这个会话上一轮是谁答的：下一轮尽量还找他，别聊着聊着换了个人
    this.sessionProvider = {};
    // 插件模组：只加载 config.plugins.enabled 里明确开着的；单个插件坏了不影响主程序
    this.plugins = new PluginHost({
      dataDir: this.dataDir,
      cfg: this.cfg,
      configPath: this.tools.ctx.configPath,
      tools: this.tools,
      store: this.store,
      speakUp: (sid, o) => this.speakUp(sid, o),
      idleMinutes: (sid) => this.idleMinutes(sid)
    });
    try { this.plugins.load(); } catch (e) { /* 插件加载失败不拖垮启动 */ }
    // 内置 MCP 客户端：默认关，配置了才启动；启动是异步的，不挡开窗
    this.mcp = new McpClient({ dataDir: this.dataDir, cfg: this.cfg });
    this._mcpStarted = false;
    this._subRunning = false;
  }

  // 由 server 启动时调一次；失败了只记日志，聊天照常（这一轮少几个工具而已）
  async initMcp() {
    if (this._mcpStarted) return 0;
    this._mcpStarted = true;
    if (!this.mcp.enabled()) return 0;
    try {
      const regs = await this.mcp.startAll();
      for (const r of regs) {
        try { this.tools.registerPluginTool(r.def, 'mcp:' + r.server, r.fn); }
        catch (e) { /* 重名就跳过 */ }
      }
      return regs.length;
    } catch (e) {
      return 0;
    }
  }

  closeMcp() { try { this.mcp.closeAll(); } catch (e) {} }

  embedFn() {
    const cfg = this.cfg.embedding || {};
    if (!cfg.enabled) return null;
    return async (texts) => {
      try {
        const arr = await this.router.embed(texts);
        return arr;
      } catch (e) { return null; }
    };
  }

  recallBlock(query) {
    return recall(this.store, query, { topK: (this.cfg.memory && this.cfg.memory.topK) || 5, embed: this.embedFn() });
  }

  sessionFile(sessionId) {
    return path.join(this.sessDir, String(sessionId || 'default').replace(/[^\w.-]/g, '_') + '.json');
  }

  summaryPath(sessionId) {
    return path.join(this.sessDir, String(sessionId || 'default').replace(/[^\w.-]/g, '_') + '.summary.md');
  }

  loadSummary(sessionId) {
    try { return fs.readFileSync(this.summaryPath(sessionId), 'utf8').trim(); } catch (e) { return ''; }
  }

  saveSummary(sessionId, txt) {
    try { ensureDir(this.sessDir); fs.writeFileSync(this.summaryPath(sessionId), String(txt || ''), 'utf8'); } catch (e) {}
  }

  // 丢历史之前先蒸馏：把旧对话里值得记的事实/约定捞出来存进记忆库，删了也不丢
  // 蒸馏（提炼）过程写日志，失败进队列下次重试——别静默丢
  distillLog(entry) {
    try { appendJsonl(path.join(this.dataDir, 'distill.log'), Object.assign({ ts: nowIso() }, entry)); } catch (e) {}
  }

  queueFile() { return path.join(this.dataDir, 'distill-queue.json'); }

  enqueueDistill(msgs, sessionId, err) {
    try {
      const q = readJson(this.queueFile(), { items: [] });
      if (!Array.isArray(q.items)) q.items = [];
      q.items.push({ at: nowIso(), session: sessionId || '', error: String(err || '').slice(0, 200), msgs: (msgs || []).slice(-20) });
      if (q.items.length > 20) q.items = q.items.slice(-20);
      writeJson(this.queueFile(), q);
      this.distillLog({ event: '入队待重试', session: sessionId, error: String(err || '').slice(0, 200) });
    } catch (e) {}
  }

  // 记忆每日快照：每天第一次启动（或跨天）把记忆库复制到 data/backups/memory/<日期>/，留最近 7 份
  snapshotMemory() {
    const day = new Date();
    const key = day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' + String(day.getDate()).padStart(2, '0');
    const flagFile = path.join(this.dataDir, 'memory-snapshot.json');
    const flag = readJson(flagFile, {});
    if (flag.day === key) return { ok: true, skipped: true, day: key };
    const root = path.join(this.dataDir, 'backups', 'memory');
    const dir = path.join(root, key);
    try {
      ensureDir(dir);
      const memDir = path.join(this.dataDir, 'memory');
      for (const f of ['memories.json', 'people.json', 'events.json']) {
        const src = path.join(memDir, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
      }
      writeJson(flagFile, { day: key, at: nowIso() });
      // 只留最近 7 份
      try {
        const dirs = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
        for (const old of dirs.slice(0, Math.max(0, dirs.length - 7))) {
          fs.rmSync(path.join(root, old), { recursive: true, force: true });
        }
      } catch (e) {}
      return { ok: true, day: key, dir };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async retryDistillQueue() {
    let q;
    try { q = readJson(this.queueFile(), { items: [] }); } catch (e) { return 0; }
    if (!q || !Array.isArray(q.items) || !q.items.length) return 0;
    let left = [];
    let done = 0;
    for (const job of q.items) {
      try {
        const n = await this.distillOld(job.msgs || [], job.session || 'queue');
        if (n >= 0) done++;
        else left.push(job);
      } catch (e) { left.push(job); }
    }
    writeJson(this.queueFile(), { items: left });
    this.distillLog({ event: '队列重试', done, left: left.length });
    return done;
  }

  async distillOld(msgs, sessionId) {
    if (this.cfg.memory && this.cfg.memory.distillOnTrim === false) return 0;
    const text = (msgs || []).map(function (m) {
      return (m.role === 'user' ? '他：' : '她：') + String(m.content || '').slice(0, 300);
    }).join('\n');
    if (!text.trim()) return 0;
    let items = [];
    let failed = false;
    try {
      const res = await this.router.call([
        { role: 'system', content: '从这段对话里提炼值得长期记住的事。只保留：约定、偏好、忌口、重要日子、关系变化、明确的事实。'
          + '丢弃：寒暄、技术操作、一次性的任务细节。'
          + '输出 JSON 数组，每项 {"text":"一句不超过40字的中文事实","kind":"fact|relation|preference","pinned":true|false}。没有就输出 []。不要解释。' },
        { role: 'user', content: text.slice(-4000) }
      ], [], { taskText: '记忆蒸馏', temperature: 0.1, timeoutMs: 60000 });
      const raw = String((res.json.choices && res.json.choices[0] && res.json.choices[0].message && res.json.choices[0].message.content) || '');
      const m = raw.match(/\[[\s\S]*\]/);
      if (m) items = JSON.parse(m[0]);
      else failed = true;
    } catch (e) { items = []; failed = true; }
    const existing = (this.store && this.store.data && this.store.data.items) ? this.store.data.items : [];
    const norm = (x) => String(x || '').replace(/[\s，。、！？,.!?：:；;""'']/g, '').toLowerCase();
    const looksSameFact = (a, b) => {
      const x = norm(a), y = norm(b);
      if (!x || !y) return false;
      if (x === y) return true;
      if (x.length >= 4 && y.includes(x)) return true;
      if (y.length >= 4 && x.includes(y)) return true;
      // 中文短句只差一两个字：用二元组重合度兜住
      const bigramsOf = (t) => { const set = new Set(); for (let i = 0; i + 1 < t.length; i++) set.add(t.slice(i, i + 2)); return set; };
      const A = bigramsOf(x), B = bigramsOf(y);
      if (!A.size || !B.size) return false;
      let hit = 0;
      for (const g of A) if (B.has(g)) hit++;
      return hit / Math.min(A.size, B.size) >= 0.6;
    };

    let n = 0;
    for (const it of items) {
      const t = String((it && it.text) || '').trim();
      if (!t || t.length < 4) continue;
      if (existing.some((e) => e && e.status !== 'archived' && looksSameFact(e.text, t))) continue;
      try {
        const saved = this.memory.remember({
          text: t,
          kind: classify(t),
          importance: (it && it.pinned) ? 4 : scoreImportance(t, 'distill'),
          pinned: !!(it && it.pinned),
          source: 'distill:' + String(sessionId || 'default')
        });
        if (saved) n++;
      } catch (e) {}
    }
    this.distillLog({ event: '蒸馏完成', session: sessionId, got: items.length, saved: n, failed });
    if (failed) this.enqueueDistill(msgs, sessionId, '模型没给出可解析的 JSON');
    return n;
  }

  // 历史过阈值就把「还没总结过的旧部分」压成摘要；原文不删，只把模型窗口缩短
  async rollSummary(history, sessionId) {
    const max = (this.cfg.memory && this.cfg.memory.maxHistory) || 16;
    const keep = (this.cfg.memory && this.cfg.memory.summaryKeep) || max;
    const msgs = history.messages || [];
    const cursor = Math.max(0, Math.min(Number(history.summary_cursor) || 0, msgs.length));
    const end = Math.max(cursor, msgs.length - keep);
    // 新增的旧消息太少就不折腾模型，攒够一截再压
    if (end - cursor < 12) return history;
    const old = msgs.slice(cursor, end);
    const prev = this.loadSummary(sessionId);
    const text = old.map(function (m) { return (m.role === 'user' ? '他：' : '她：') + String(m.content || '').slice(0, 300); }).join('\n');
    let sum = '';
    try {
      const res = await this.router.call([
        { role: 'system', content: '把下面这段对话压成一段不超过 200 字的中文摘要，只留事实、约定、数字和她答应过的事。不要评价、不要客套。' },
        { role: 'user', content: (prev ? prev + '\n' : '') + text.slice(-4000) }
      ], [], { taskText: '摘要', temperature: 0.1, timeoutMs: 60000 });
      sum = String((res.json.choices && res.json.choices[0] && res.json.choices[0].message && res.json.choices[0].message.content) || '').trim();
    } catch (e) { sum = ''; }
    if (sum) this.saveSummary(sessionId, sum);
    // 压进摘要之前，先沉进记忆库，别白丢
    try { await this.distillOld(old, sessionId); } catch (e) {}
    history.summary_cursor = end;
    this.saveHistory(sessionId, history);
    return history;
  }

  loadHistory(sessionId) {
    const h = readJson(this.sessionFile(sessionId), { id: sessionId, messages: [] });
    if (!Array.isArray(h.messages)) h.messages = [];
    return h;
  }

  // 三个入口各用各的模式：窗口闲聊、DSH/QQ 干活；没单独配就沿用老的总开关
  modeFor(entry) {
    const e = String(entry || 'desktop');
    const m = (this.cfg.modes || {})[e];
    if (m === 'chat' || m === 'work') return m;
    return (this.cfg.mode === 'chat' || this.cfg.mode === 'work') ? this.cfg.mode : 'work';
  }

  // 原文不再丢：只限制给模型的窗口，完整会话留在磁盘上（可以用 search_history / 翻会话找回来）
  saveHistory(sessionId, h) {
    if (h.messages.length > 4000) h.messages = h.messages.slice(-4000);
    h.updated_at = nowIso();
    writeJson(this.sessionFile(sessionId), h);
  }

  // 工具渐进披露：前两步先只给「看」的工具，别一上来塞满。
  // allowTools === false = 这一轮不挂工具（对话模式 / 带图片的轮次）。
  toolsForStep(step, taskText, allowTools, opts) {
    if (allowTools === false) return [];
    // 场景优先：config.tools.defaultProfile 或调用方显式指定时，按场景给工具。
    // 不配就走原来的逻辑，行为一点不变（2.0 · M1）。
    const profile = (opts && opts.profile) || ((this.cfg.tools && this.cfg.tools.defaultProfile) || null);
    if (profile) {
      try { return this.tools.registry.defs(profile); } catch (e) { /* 回退到全量 */ }
    }
    const all = this.tools.defs();
    if (step >= 1) return all;
    const isTask = /写|建|改|删|跑|执行|存|提醒|记住|画|生成/.test(String(taskText || ''));
    if (isTask) return all;
    return all.filter((d) => READONLY_TOOLS.includes(d.function.name));
  }

  buildMessages(userText, recallRes, history, mode, speaker) {
    const parts = [];
    // 上下文按「字数档位」裁，不再按条数：默认 8000 字，至少留最近 4 条
    const budget = Math.max(2000, Number(this.cfg.memory && this.cfg.memory.historyChars) || 8000);
    let start = history.messages.length;
    let used = 0;
    for (let i = history.messages.length - 1; i >= 0; i--) {
      const m = history.messages[i];
      const n = typeof m.content === 'string' ? m.content.length : 1;
      if (used + n > budget && history.messages.length - i >= 4) break;
      used += n;
      start = i;
    }
    const recent = history.messages.slice(start);
    const sum = this.loadSummary(this._curSession);
    if (sum) parts.push('【之前聊到的】\n' + forPrompt(sum));
    if (recallRes.block) {
      // 上下文预算（2.0）：记忆块太大就把小模型挤没了，超了就截一段并说明还有剩的
      const memLimit = Math.max(500, Number(this.cfg.memory && this.cfg.memory.blockChars) || 3000);
      let block = String(recallRes.block);
      if (block.length > memLimit) block = block.slice(0, memLimit) + '\n（记忆还有更多，先看这些）';
      parts.push('【参考记忆】（下面分两段：「关于他的事实」里的「他」就是跟你说话的那个人；'
        + '「回忆片段」是你俩之间发生过的话和情绪，不是关于他的事实，别照搬。'
        + '回他的时候用「你」称呼他，别对他说「用户」两个字，也别把他的事说成你自己的）\n' + block);
    }
    const ev = this.events.block(5);
    if (ev) parts.push('【事件时间轴】\n' + forPrompt(ev));
    // 小模型最容易在这一类问句上翻车（把「我」当成它自己，或者编个生日糊弄）。
    // 光写系统规则它记不住，就在问题前面直接点一句；记忆里没有就明说只能回答没记着。
    const askedAboutHim = askingAboutHimself(userText);
    let asked = '';
    if (askedAboutHim && !speaker) {
      const tops = topicOf(userText);
      const hisCount = ((recallRes && recallRes.hits) || []).filter((h) => isHisHit(h)
        && (!tops.length || tops.some((w) => String(h.text).indexOf(w) >= 0))).length;
      asked = hisCount
        ? '（他这句话是在问他自己：用记忆里关于他的事回答，称呼他用「你」；不许用你自己的名字、喜好或身份来顶）\n'
        : '（他这句话是在问他自己，但记忆里没有这条。你只能老实说「这个我没记着」，不许猜日期、名字、喜好，也不许编）\n';
    }
    const userContent = parts.length ? parts.join('\n\n') + '\n\n【这次的话】\n' + userText : userText;    // 对话模式这一轮一个工具都没有：必须说清楚，不然小模型会顺嘴说「我建好了」，其实啥也没干
    const modeNote = mode === 'chat'
      ? '（现在是对话模式：这一轮你没有任何工具，读写文件、跑命令、上网、看屏幕都做不了。他要你动手时，直接说这得切到工作模式，绝对不许说「已经做了」或者假装做过。）\n'
      : '';
    // 群里不是本人说的：得点一句说话人是谁，不然她会把群友的「我」当成主人
    const groupNote = speaker
      ? '（这句是群里「' + speaker.name + '」说的，不是主人本人。他嘴里的「我」指他自己；【关于他的事实】里的「他」是主人，别当成他的；关于谁的事都要按名字对号。）\n'
      : '';
    // 只有他问到「你」本人时才加身份说明：常驻的话，小模型容易抓着这句不放（问车位也答「我叫鲸倩」）
    const asksMe = /你(叫|的名字|是谁|多大了?|几岁|住哪|住哪里|是男是女|是机器人|是AI|是ai)/.test(String(userText || ''));
    return [{ role: 'system', content: String(this.cfg.persona || DEFAULT_PERSONA) + '\n\n' + todayLine() + (asksMe ? '\n' + SELF_LINE : '') }]
      .concat(recent)
      .concat([{ role: 'user', content: modeNote + groupNote + asked + userContent }]);
  }

  // 换掉记忆的实现（2.0 · M1 契约）：只认 remember / search / forget 三个动作。
  // 换进来之后，记东西的地方（自动记住、整理）都走新实现。
  setMemory(impl) {
    if (!impl || ['remember', 'search', 'forget'].some((k) => typeof impl[k] !== 'function')) {
      throw new Error('记忆实现要提供 remember / search / forget 三个方法');
    }
    this.memory = impl;
    this.memorySwapped = true;
    // 工具层手里也有一份引用，一起换掉，不然记东西还是记到旧的那份
    if (this.tools && this.tools.ctx) this.tools.ctx.memory = impl;
    return true;
  }

  // 换模式时把「这个会话上次是谁答的」清掉：切回对话模式就该回到免费的家，别一直挂在付费那家
  resetSessionProviders() {
    this.sessionProvider = {};
  }

  capture(userText, speaker) {
    if (!this.cfg.memory || this.cfg.memory.autoCapture === false) return null;
    if (!CAPTURE.test(String(userText))) return null;
    const raw = String(userText).trim();
    // 问句不记：他问「我喜欢什么」是在问，不是在告诉你事实。
    // 以前会把问句记成「他喜欢喝什么」，后面越问越乱，人也分不清了。
    if (/[?？]\s*$/.test(raw)) return null;
    if (/(吗|呢|什么|谁|哪天|多少|怎么|为什么|哪一个?)[？?]?\s*$/.test(raw)) return null;
    // 复述/元话语不记：像「你：…」这种带前缀的、以及「我说/你以为」这类，都不是事实
    if (/^你\s*[：:]/.test(raw)) return null;
    if (/^(我说|你说|你以为|我问|你问)/.test(raw)) return null;
    const pinned = /记住|别忘|永远|一定/.test(raw);
    // 存的是「那件事」，不是「叫她记住」这句话本身：
    // 「记住：我喜欢喝美式咖啡。」要落成「我喜欢喝美式咖啡」，否则和已有记忆对不上、去重也失效。
    // 「不对，我喜欢咖啡」这种更正：先把「不对/不是」剥掉，剩下的当事实存
    const clipped = raw.replace(/^(不对|不是|说错|改口|改成|其实)[，,：:、\s]*/, '');
    const text = clipped
      .replace(/^(?:帮我|给我)?(?:记一下|记住|记着|别忘了|别忘)[:：,，\s]*/g, '')
      .replace(/[，,。\s]*(?:别忘|别忘了|记住)[。！!]?$/g, '')
      .trim()
      .slice(0, 140);
    if (!text) return null;
    const cls = classify(text);
    const imp = pinned ? 4 : scoreImportance(text, 'auto-capture');
    // 认人：群里说话的人优先按他本人挂；私聊/本人就按句子里出现的别名，没有就是 owner
    const who = speaker ? null : this.people.whoSaid(raw);
    const personId = speaker ? ('p_qq_' + (speaker.id || speaker.name)) : (who ? who.id : 'owner');
    const personName = speaker ? speaker.name : '用户';
    const it = this.memory.remember({ text: toPersonFact(text, personName), kind: cls, importance: imp, pinned, source: speaker ? 'qq-group' : 'auto-capture', person: personId });
    // 他说「不对，我喜欢咖啡」这种更正：把同动词的旧偏好顶掉，别两条并存
    if (it && /^(不对|不是|说错|改口|改成|其实)/.test(raw)) {
      const fact = toPersonFact(text, personName);
      const verb = (fact.match(/^(用户|.+?)(喜欢|爱|讨厌|爱吃|爱喝)/) || [])[2];
      if (verb) {
        const olds = this.store.active().filter((x) => x.id !== it.id && (x.person || 'owner') === personId && x.text.indexOf(personName + verb) === 0 && x.text !== it.text);
        for (const old of olds) {
          // 不管当初存成 fact 还是 preference，同一个动词的旧说法都被新说法顶掉
          this.store.archive(old.id);
        }
      }
    }
    return it;
  }

  // 子智能体：一轮独立任务（自己调工具、最多六步），做完只回一段结论。
  // 它不写主会话历史、不记忆，避免把派活的中间过程灌进她的记忆。
  async runSubAgent(task, model) {
    const text = String(task || '').trim();
    if (!text) return '要派什么活？说清楚点。';
    if (this._subRunning) return '已经有一个子智能体在跑了，等它回来再派。';
    this._subRunning = true;
    try {
      const messages = [
        { role: 'system', content: '你是鲸倩派出去的子智能体，只做交代的这一件事。有工具就真的用工具做完；做完用不超过 300 字说结论、关键证据和没做完的地方。别客套、别解释自己。' },
        { role: 'user', content: text }
      ];
      const defs = this.tools.defs().filter((d) => d.function.name !== 'sub_agent');
      let last = '';
      for (let step = 0; step < 6; step++) {
        const res = await this.router.call(messages, defs, {
          taskText: text,
          temperature: 0.3,
          timeoutMs: (this.cfg.budget && this.cfg.budget.perCallSeconds || 120) * 1000
        });
        const msg = (res.json.choices && res.json.choices[0] && res.json.choices[0].message) || {};
        messages.push(msg);
        if (msg.tool_calls && msg.tool_calls.length) {
          for (const call of msg.tool_calls) {
            let args = {};
            try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) { args = {}; }
            // 子智能体不能替用户点头：红线动作只会拿到「需要确认」的提示
            const out = await this.tools.run(call.function.name, args, { confirmed: false });
            messages.push({ role: 'tool', tool_call_id: call.id, content: truncate(String(out), 2000) });
          }
          continue;
        }
        last = String(msg.content || '').trim();
        break;
      }
      return '子智能体回来了：\n' + (last || '（它没给出结论）');
    } catch (e) {
      return '子智能体没跑成：' + e.message;
    } finally {
      this._subRunning = false;
    }
  }

  // 自由时间：没人理她的时候，她自己起个头。
  // 不从 chat() 走（那得要一条用户消息），这里单独组一次请求，说完直接写进历史，
  // 窗口那边轮询会话就能看到；QQ 那边由插件拿着这句去发。
  async speakUp(sessionId, opts) {
    opts = opts || {};
    const sid = sessionId || 'default';
    const idleMin = Math.max(1, Number(opts.idleMinutes) || 30);
    this._curSession = sid;
    let history = this.loadHistory(sid);
    try { history = await this.rollSummary(history, sid); } catch (e) {}
    const recent = history.messages.slice(-8);
    const lastUser = recent.slice().reverse().find((m) => m.role === 'user');
    let recallRes = { block: '', hits: [] };
    try { recallRes = await this.recallBlock(lastUser ? String(lastUser.content || '') : ''); } catch (e) {}
    const parts = [];
    const sum = this.loadSummary(sid);
    if (sum) parts.push('【之前聊到的】\n' + forPrompt(sum));
    if (recallRes && recallRes.block) parts.push('【参考记忆】\n' + recallRes.block);
    try { const ev = this.events.block(3); if (ev) parts.push('【事件时间轴】\n' + forPrompt(ev)); } catch (e) {}
    parts.push('（现在是自由时间：你已经 ' + idleMin + ' 分钟没跟他说话了。'
      + '就说一句短话，像忽然想起他那样，一两句就够；可以问他在忙什么、说你在做什么、或者顺着你们上次聊的接着说。'
      + '别只问「在吗」，别说教，别催他睡觉喝水，别提你等了多久，也别提时间。'
      + '拿不准的事别提：别凭空说文件、文档、工作上的事，除非【参考记忆】里真有、或者你们刚才真的说过。'
      + '只有实在不想开口的时候，才只回一个词：SILENT）');
    const messages = [{ role: 'system', content: String(this.cfg.persona || DEFAULT_PERSONA) + '\n\n' + todayLine() }]
      .concat(recent)
      .concat([{ role: 'user', content: parts.join('\n\n') }]);
    const res = await this.router.call(messages, [], {
      taskText: '自由时间',
      temperature: 0.95,
      maxTokens: 160,
      timeoutMs: ((this.cfg.budget && this.cfg.budget.perCallSeconds) || 45) * 1000
    });
    let reply = String((res.json.choices && res.json.choices[0] && res.json.choices[0].message && res.json.choices[0].message.content) || '').trim();
    reply = reply.replace(/^[\s"'「『]+|[\s"'」』]+$/g, '').trim();
    if (!reply || /^SILENT[。.!！]?$/i.test(reply)) return { spoke: false, reply: '' };
    if (reply.length > 140) reply = reply.slice(0, 140);
    history.messages.push({ role: 'assistant', content: reply });
    this.saveHistory(sid, history);
    return { spoke: true, reply, idleMinutes: idleMin };
  }

  // 会话最后一次动静（文件修改时间）到现在隔了几分钟：插件用它判断该不该开口
  idleMinutes(sessionId) {
    try {
      const st = fs.statSync(this.sessionFile(sessionId || 'default'));
      return Math.round((Date.now() - st.mtimeMs) / 60000);
    } catch (e) { return -1; }
  }

  async chat(userText, opts) {
    opts = opts || {};
    const sessionId = opts.sessionId || 'default';
    // 两个模式：
    //   chat = 只聊天（不挂工具，谁都能用，免费模型也轮得上）
    //   work = 干活（挂全套工具，只让能动手的模型接）
    const mode = (opts.mode === 'chat' || opts.mode === 'work') ? opts.mode : this.modeFor(opts.entry);
    const workMode = mode === 'work';
    // 群里说话的人：非主人时，他嘴里的「我」指他自己，记忆要挂到他名下
    const sp = (opts.speaker && typeof opts.speaker === 'object' && String(opts.speaker.name || '').trim())
      ? { id: String(opts.speaker.id || ''), name: String(opts.speaker.name).trim().slice(0, 40), owner: !!opts.speaker.owner }
      : null;
    let speaker = null;
    if (sp && !sp.owner) {
      const known = this.people.whoSaid(sp.id) || this.people.whoSaid(sp.name);
      if (known && known.id === 'owner') speaker = null;
      else {
        speaker = sp;
        if (sp.id && !this.people.get('p_qq_' + sp.id)) {
          try { this.people.upsert({ id: 'p_qq_' + sp.id, name: sp.name, kind: 'friend', relation: '群友' }); } catch (e) {}
        }
      }
    }
    const started = Date.now();
    const budget = this.cfg.budget || {};
    const maxSeconds = (budget.perTaskSeconds || 180) * 1000;
    const maxTokens = budget.perTaskTokens || 200000;
    const maxSteps = (this.cfg.route && this.cfg.route.maxSteps) || 12;
    const text = String(userText || '').trim();
    const images = Array.isArray(opts.images) ? opts.images : [];
    const attachBlock = String(opts.attachBlock || '');
    if (!text && !images.length && !attachBlock) return { reply: '你想说啥？', stats: {}, memory: null };
    // 只有图片、没打字时，也要给历史和记忆一句能读的「这件事」
    const displayText = text || ('（发来' + (images.length ? images.length + ' 张图片' : '附件') + '：' + images.map((x) => x.name).join('、') + '）');

    // 「确认」= 把刚才被红线拦下那一步重放一次
    if (/^(确认|确定|同意|可以|继续|就这么办|执行吧?)$/.test(text) && this.pending && Date.now() - this.pending.at < 10 * 60000) {
      const p = this.pending;
      this.pending = null;
      const r = await this.tools.run(p.tool, p.args, { confirmed: true });
      const reply = '做了：' + String(r).slice(0, 800);
      const h = this.loadHistory(sessionId);
      h.messages.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      this.saveHistory(sessionId, h);
      return { reply, stats: { confirmed: true, ms: Date.now() - started }, memory: null, trace: [] };
    }

    this._curSession = sessionId;

    // 缓存（2.0 · 节省第一层）：同一个问法问第二遍，不再花一次钱。
    // 只认「去掉标点空格后完全一样」的，宁可少命中也不给错答案。
    const cacheOn = !process.env.JQ_NO_CACHE && !(this.cfg.cache && this.cfg.cache.enabled === false);
    if (cacheOn && text && !images.length && !attachBlock && mode === 'chat') {
      try {
        const hit = this.cache.get(text);
        if (hit) {
          const h0 = this.loadHistory(sessionId);
          h0.messages.push({ role: 'user', content: text }, { role: 'assistant', content: hit.reply });
          this.saveHistory(sessionId, h0);
          appendJsonl(path.join(this.dataDir, 'turns.log'), { ts: nowIso(), session: sessionId, text: truncate(text, 200), cached: true });
          return { reply: hit.reply, stats: { cached: true, provider: 'cache', steps: 0, ms: 0, tools: [], tokens: 0, cost: 0 }, memory: [], trace: [] };
        }
      } catch (e) { /* 缓存坏了不影响正常聊 */ }
    }

    let history = this.loadHistory(sessionId);
    try { history = await this.rollSummary(history, sessionId); } catch (e) {}
    const recallRes = await this.recallBlock(text);
    // 他问自己的事，就只喂「关于他的事实」；不然她的自述（「我叫鲸倩」）会被当成他的信息
    if (recallRes && askingAboutHimself(text)) {
      const his = (recallRes.hits || []).filter((h) => isHisHit(h));
      recallRes.block = his.length
        ? '【关于他的事实】\n' + his.map((h) => '- ' + (h.pinned ? '★' : '') + forPrompt(h.text)).join('\n')
        : '';
    }
    const messages = this.buildMessages(text, recallRes, history, mode, speaker);
    const captured = this.capture(text, speaker);
    // 附件：文本内容接在这一次的用户消息后面；图片换成 OpenAI 的多模态 content 数组。
    // 注意只影响这一趟发给模型的 messages，历史里仍只存用户打的那句话，免得越聊越臃肿。
    if (attachBlock || images.length) {
      const last = messages[messages.length - 1];
      let content = String(last.content || '');
      if (attachBlock) content += '\n\n' + attachBlock;
      last.content = images.length
        ? [{ type: 'text', text: content }].concat(images.map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl } })))
        : content;
    }

    let usedTools = [];
    let retriedCloud = false;
    // 带图片的这轮不挂工具：视觉模型多半不带工具，先让她把图看明白；
    // 对话模式则整轮都不挂工具。
    // 外部工具（换脑）：对方把它的工具清单递过来，我们只负责「要不要调、调哪个」，
    // 真正执行由对方去做——所以这一轮只走一步，把 tool_calls 原样交回去。
    const externalTools = Array.isArray(opts.externalTools) ? opts.externalTools : null;
    const useTools = (workMode || !!externalTools) && !images.length;

    // 档位 → 工具场景（2.0）：便宜档只给「看得见的」，动手的留给能干的档。
    // 没配 config.tools.tierProfiles 就什么都不变。
    let tierProfile = null;
    try {
      const tp = (this.cfg.tools && this.cfg.tools.tierProfiles) || null;
      if (tp && this.cfg.route && this.cfg.route.autoTier && useTools) {
        const t = classifyTier(this.cfg, text, { needTools: useTools });
        tierProfile = tp[t] || null;
      }
    } catch (e) { /* 配错了就当没配 */ }
    this._selfFix = false;
    this._selfFix2 = false;
    let planText = '';
    // 看着像多步活：先让她说个三五步的计划，后面照着走，别边想边做跑偏（只在干活模式）
    if (useTools && looksMultiStep(text)) {
      try {
        const pr = await this.router.call(
          messages.concat([{ role: 'user', content: '先用三到五句说清楚你准备怎么做：一句一步，不要调用工具，不要客套。' }]),
          [],
          { taskText: '先出计划', temperature: 0.3, maxTokens: 300, timeoutMs: 45000 }
        );
        const pc = String((pr.json.choices && pr.json.choices[0] && pr.json.choices[0].message && pr.json.choices[0].message.content) || '').trim();
        if (pc) {
          planText = pc.slice(0, 400);
          messages.push({ role: 'assistant', content: '我的做法：\n' + planText });
        }
      } catch (e) { /* 出计划失败就照常干，不挡主线 */ }
    }
    const trace = [];
    let totalPrompt = 0, totalCompletion = 0, cost = 0;
    let provider = '';
    let steps = 0;
    let lastText = '';

    for (let step = 0; step < maxSteps; step++) {
      steps = step + 1;
      if (Date.now() - started > maxSeconds) { lastText = '（这条太绕了，我先停一下，超了这轮的时间上限。）'; break; }
      if (totalPrompt + totalCompletion > maxTokens) { lastText = '（token 预算用完了，我先停一下。）'; break; }

      const ctxChars = messages.reduce(function (n, m) {
        const c = m && m.content;
        if (typeof c === 'string') return n + c.length;
        if (Array.isArray(c)) return n + c.reduce(function (k, x) { return k + String((x && x.text) || '').length; }, 0);
        return n;
      }, 0);
      const callOpts = {
        taskText: text,
        contextChars: ctxChars,
        prefer: this.sessionProvider[sessionId],
        skipLocal: retriedCloud,
        requireVision: images.length > 0,
        temperature: this.cfg.temperature == null ? 0.7 : this.cfg.temperature,
        timeoutMs: ((this.cfg.budget && this.cfg.budget.perCallSeconds) || 120) * 1000
      };
      let res;
      try {
        res = await this.router.call(messages, externalTools || this.toolsForStep(step, text, useTools, { profile: tierProfile }), callOpts);
      } catch (e) {
        if (e.code === 'NO_VISION') {
          const names = images.map((x) => x.name).join('、');
          lastText = '图我收下了（' + names + '），但现在接的模型看不了图片，我也不硬猜。'
            + '想让我看图的话，在设置里加一家支持视觉的提供方（config.json 的 provider 上写 "vision": true），'
            + '或者直接把图里要紧的字打给我。';
          steps = Math.max(steps, 1);
          break;
        }
        throw e;
      }
      // 本地模型偶尔会「空着回来」（没说话、也没调工具）：换云端补一次，别把空白甩给人
      const probeMsg = (res.json.choices && res.json.choices[0] && res.json.choices[0].message) || {};
      if (!retriedCloud && res.provider.tier === 'local'
        && !(probeMsg.tool_calls && probeMsg.tool_calls.length) && !String(probeMsg.content || '').trim()) {
        retriedCloud = true;
        totalPrompt += res.stat.prompt_tokens;
        totalCompletion += res.stat.completion_tokens;
        cost += res.stat.cost;
        try {
          const cloudOpts = Object.assign({}, callOpts, { skipLocal: true, prefer: '' });
          res = await this.router.call(messages, this.toolsForStep(step, text, useTools, { profile: tierProfile }), cloudOpts);
        } catch (e) {
          this.sessionProvider[sessionId] = '';
        }
      }
      provider = res.provider.name;
      this.sessionProvider[sessionId] = provider;
      totalPrompt += res.stat.prompt_tokens;
      totalCompletion += res.stat.completion_tokens;
      cost += res.stat.cost;

      const msg = (res.json.choices && res.json.choices[0] && res.json.choices[0].message) || {};
      // 有的家（比如 glm-4-flash）不按规矩回 tool_calls，而是把调用写成一段文本：
      //   fetch_url
      //   {"url":"..."}
      // 这里兜一下，把它认回成真的工具调用，免得它对着用户念一段 JSON。
      if (!(msg.tool_calls && msg.tool_calls.length) && typeof msg.content === 'string') {
        const m = /^\s*([a-z_][a-z0-9_]{2,30})\s*\n?\s*(\{[\s\S]*\})\s*$/i.exec(msg.content);
        const known = m && this.tools.defs().some((d) => d.function.name === m[1]);
        if (known) {
          try {
            JSON.parse(m[2]);
            msg.tool_calls = [{ id: 'textcall_' + step, type: 'function', function: { name: m[1], arguments: m[2] } }];
            msg.content = '';
          } catch (e) { /* 不是合法 JSON 就当普通文本 */ }
        }
      }
      messages.push(msg);
      if (msg.tool_calls && msg.tool_calls.length) {
        // 换脑：工具是对方的，我们一个都不执行，原样交回去让它自己跑
        if (externalTools) {
          return {
            reply: '',
            toolCalls: msg.tool_calls,
            stats: { passthrough: true, steps: steps, provider: provider, ms: Date.now() - started },
            memory: null,
            trace: []
          };
        }
        for (const call of msg.tool_calls) {
          let args = {};
          try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) { args = { _raw: call.function.arguments }; }
          const out = await this.tools.run(call.function.name, args);
          usedTools.push(call.function.name);
          trace.push({ tool: call.function.name, args: truncate(JSON.stringify(args), 200), result: truncate(String(out), 300) });
          if (this.tools.pending) this.pending = this.tools.pending;
          // 工具输出太长就别整段进上下文：给模型看前 4000 字，够判断了
          messages.push({ role: 'tool', tool_call_id: call.id, content: truncate(String(out), 4000) });
        }
        continue;
      }

      // 说了要做却一次工具都没调：提醒它一次（只提醒一次，别死循环）
      const looksLikeTask = /写|建|创建|生成|改|删|跑|执行|查|列|存|记|提醒/.test(text);
      if (useTools && !usedTools.length && looksLikeTask && step === 0) {
        messages.push({ role: 'user', content: '（你刚才没调用任何工具就直接回答了。请现在真的调用工具去做，别只说做完了。）' });
        continue;
      }
      lastText = String(msg.content || '').trim();
      // 自洽：工具真跑成功，回复却说没权限/没做 → 让它按工具返回值改口一次
      const denies = /没有权限|不在白名单|无权执行|不能执行|无法执行|做不了|没权限/.test(lastText);
      if (denies && usedTools.length && !this._selfFix) {
        const lastToolMsg = [...messages].reverse().find((m) => m && m.role === 'tool');
        const toolOk = lastToolMsg && !/拦|拒绝|出错|失败|不存在/.test(String(lastToolMsg.content || ''));
        if (toolOk && step < maxSteps - 1) {
          messages.push({ role: 'user', content: '（工具其实已经执行成功了，返回值在下面。请按真实结果重说一遍，不要说自己没权限。）' });
          this._selfFix = true;
          continue;
        }
      }
      // 反向自洽：工具其实失败了/要确认，她却说「做好了」→ 让她按真实结果改一次
      const claimsDone = /(做好了|完成了|搞定了|已经(做好|完成|建好|写好))/.test(lastText);
      const toolFailed = trace.some((t) => /出错|失败|不存在|拒绝|拦|需要你明确点头|不在白名单/.test(String(t.result || '')));
      if (claimsDone && toolFailed && !this._selfFix2 && step < maxSteps - 1) {
        messages.push({ role: 'user', content: '（有工具返回的是失败或需要确认，别报「做好了」。按真实结果修正，或者把卡在哪一步说清楚。）' });
        this._selfFix2 = true;
        continue;
      }
      break;
    }
    this._selfFix = false;

    // 兜底：他问自己的事、记忆里又没有，而回答里蹦出了日期/数字/名字 → 这就是编的，直接换成实话。
    // 小模型经常不听提示，只能在这一层挡一下。
    let reply = lastText || '（这轮没出结论，要不再说一次？）';
    const tops2 = topicOf(text);
    const hisHits = (recallRes.hits || []).filter((x) => isHisHit(x)
      && (!tops2.length || tops2.some((w) => String(x.text).indexOf(w) >= 0)));
    if (askingAboutHimself(text) && hisHits.length === 0 && reply.length > 0) {
      // 他这句话问的那个话题，之前的对话里他自己说过没有
      const hist = this.loadHistory(sessionId);
      const histText = (hist.messages || []).filter((m) => m && m.role === 'user').map((m) => String(m.content || '')).join(' ');
      const topic = tops2[0] || '';
      const saidBefore = topic.length > 0 && histText.indexOf(topic) >= 0;
      const claims = /(\d{1,2}\s*月|[一二三四五六七八九十]{1,2}\s*月|\d{1,2}\s*号|\d{4}\s*年|生日(是|在|那)|名字(是|叫)|你(之前|上次|以前)?(说过|喜欢|爱喝|爱吃|讨厌|住))/.test(reply);
      if (claims && !saidBefore) reply = '这个我没记着，你直接告诉我吧，我记住了以后就不会忘。';
    }
    // 今日花费上限：超了提醒一次（每天只提一次），让她自己心里有数
    const cap = Number((this.cfg.budget || {}).dailyCostCapCNY) || 0;
    if (cap > 0) {
      const todayLedger = this.router.today();
      const spent = Number((todayLedger.total || {}).cost) || 0;
      if (spent > cap) {
        const flagFile = path.join(this.dataDir, 'budget-warned.json');
        const flag = readJson(flagFile, {});
        if (flag.day !== todayLedger.date) {
          writeJson(flagFile, { day: todayLedger.date, at: nowIso(), spent: Math.round(spent * 1e6) / 1e6 });
          reply += '\n（今天已经花到 ¥' + spent.toFixed(3) + '，超过你设的 ¥' + cap + ' 了，我先尽量用本地的。）';
        }
      }
    }
    // 对话模式里认出是「要动手的活」：不自己切，先问一句，让他点头再换模式
    let suggestMode = '';
    if (!workMode && looksLikeWork(text)) {
      suggestMode = 'work';
      reply += '\n（这活儿得动手，我现在还没开始。要我切到工作模式吗？切过来我就用能动手的模型去做。）';
    }
    const h = this.loadHistory(sessionId);
    h.messages.push({ role: 'user', content: displayText }, { role: 'assistant', content: reply });
    this.saveHistory(sessionId, h);

    if (this.cfg.memory && this.cfg.memory.writeEvents !== false) {
      try { this.events.build(this.store); } catch (e) {}
    }

    const stats = {
      provider,
      mode,
      suggest_mode: suggestMode,
      steps,
      prompt_tokens: totalPrompt,
      completion_tokens: totalCompletion,
      total_tokens: totalPrompt + totalCompletion,
      cost: Math.round(cost * 1e6) / 1e6,
      ms: Date.now() - started,
      tools: usedTools,
      memory_used: recallRes.hits.length,
      memory_vector: recallRes.used_vector,
      captured: captured ? captured.id : null,
      plan: planText || ''
    };
    // 引用闸（2.0）：她说生成到/保存到某个路径了，先验一下真有没有。
    // 查出来不改答案，只在后面补一句——改了反而前后矛盾。
    try {
      const g = referenceGate(reply);
      if (g.flagged.length) {
        reply = g.reply;
        stats.reference_flags = g.flagged;
      }
    } catch (e) {}

    // 干净的回答才进缓存：用了工具的（有副作用）、被引用闸标记的（她自己都拿不准）、太长的都不要
    if (cacheOn && text && mode === 'chat' && !images.length && !attachBlock) {
      try { this.cache.set(text, reply, { usedTools: usedTools, flagged: stats.reference_flags || [] , provider: provider }); } catch (e) {}
    }

    appendJsonl(path.join(this.dataDir, 'turns.log'), Object.assign({ ts: nowIso(), session: sessionId, text: truncate(text, 200) }, stats));
    return { reply, stats, memory: recallRes.hits, trace };
  }

  consolidate() {
    const r = consolidate(this.store, this.events, (this.cfg.memory && this.cfg.memory.consolidate) || {});
    return r;
  }

  startIdleConsolidate(minutes) {
    const m = Number(minutes) || 0;
    if (!m) return;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => {
      try {
        const r = this.consolidate();
        if (r.merged.length || r.compressed.length) console.log('[consolidate] 合并 ' + r.merged.length + ' / 压摘要 ' + r.compressed.length);
      } catch (e) { console.error('[consolidate] 失败：' + e.message); }
    }, m * 60000);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  selfcheck() {
    const cfg = this.cfg;
    const providers = (cfg.providers || []).map((p) => ({
      name: p.name, model: p.model, tier: p.tier || 'cloud', ready: this.router.ready(p)
    }));
    const today = this.router.today();
    const out = {
      ok: true,
      at: nowIso(),
      node: process.version,
      platform: process.platform,
      port: cfg.port || 7889,
      providers,
      ready_providers: providers.filter((p) => p.ready).length,
      memory: { count: this.store.count(), events: this.events.all().length },
      ledger_today: {
        calls: today.total.calls,
        tokens: today.total.prompt_tokens + today.total.completion_tokens,
        cost: Math.round(today.total.cost * 1e6) / 1e6
      },
      sandbox: sandbox.status({ sandboxMode: cfg.sandbox && cfg.sandbox.mode }),
      workspace: path.relative(this.root, this.workspace).replace(/\\/g, '/'),
      warnings: []
    };
    if (!out.ready_providers) out.warnings.push('没有可用的模型：填一家云端 key 或本机起 Ollama');
    if (!fs.existsSync(this.workspace)) out.warnings.push('工作目录不见了');
    out.ok = out.warnings.length === 0;
    writeJson(path.join(this.dataDir, 'selfcheck.json'), out);
    return out;
  }
}

module.exports = { Her, DEFAULT_PERSONA, toUserFact };
