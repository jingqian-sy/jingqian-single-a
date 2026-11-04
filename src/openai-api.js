'use strict';
/*
 * 换脑：把自己的脑子借出去（OpenAI 兼容接口）
 *
 * 干什么：别的 AI 客户端（DSH、Cherry Studio、任何认 OpenAI 格式的）把地址指到
 *   本机的 http://127.0.0.1:<端口>/v1，聊天就由她来答——用她的人格、她的记忆。
 *
 * 只给本机用：这个口等于她的脑子，不设登录，暴露到公网就是把家底送人。
 *
 * 支持：
 *   GET  /v1/models            列出可用的「模型」（其实就她自己）
 *   POST /v1/chat/completions  { model, messages, stream }
 *
 * 第一版是纯对话：外面传进来的 tools 先不接（工具那层要等契约统一之后再做）。
 * 历史由对方维护（它每次都传全量），所以这边每次调用前把临时会话清空，
 * 只用最后一条用户消息 + 她自己的记忆和人格，避免两份历史叠在一起。
 */
const crypto = require('crypto');
const { tokenCount } = require('./util');

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 4 * 1024 * 1024) { reject(new Error('请求太大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

// 对方客户端会把自家的系统提示、技能清单、工作区规则也塞进消息里。
// 这些东西对她的记忆召回是纯噪音，得筛掉，不然她会答成「DSH 那个 coding agent」。
const NOISE = /<system-reminder>|The following workspace instructions|workspace instructions|<skill\b|available skills|session title from this JSON|Generate the session title/i;

// 把对方传来的历史拼成一段「你们刚才在聊」——她的记忆是长久的，
// 但这一轮对话的上下文得由对方给，两边不重复记。
function contextBlock(messages) {
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .filter((m) => !NOISE.test(m.content))
    .slice(0, -1);                       // 最后一条是这次的话，单独处理
  if (!list.length) return '';
  const lines = list.slice(-8).map((m) => (m.role === 'user' ? '他：' : '你：') + m.content.trim().slice(0, 400));
  return '【你们刚才在聊】（这一段是对方客户端提供的上下文，不是你的新记忆）\n' + lines.join('\n');
}

function lastUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== 'user') continue;
    let t = '';
    if (typeof m.content === 'string') t = m.content.trim();
    else if (Array.isArray(m.content)) t = m.content.filter((x) => x && x.type === 'text').map((x) => x.text || '').join('\n').trim();
    if (!t) continue;
    // 纯噪音（比如 DSH 让她给会话起标题）不算他在说话
    if (NOISE.test(t)) continue;
    return t;
  }
  return '';
}

function chunk(res, text, meta) {
  const id = 'chatcmpl-' + crypto.randomBytes(8).toString('hex');
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'connection': 'keep-alive'
  });
  const base = { id, object: 'chat.completion.chunk', created, model: meta.model || 'jingqian' };
  const send = (delta, finish) => {
    res.write('data: ' + JSON.stringify(Object.assign({}, base, {
      choices: [{ index: 0, delta, finish_reason: finish || null }]
    })) + '\n\n');
  };
  send({ role: 'assistant', content: '' }, null);
  // 没有真流式：整段已经生成了，按句切成几块推，客户端看着像在打字
  const parts = String(text).match(/[^。！？!?\n]{1,40}[。！？!?\n]?/g) || [String(text)];
  for (const p of parts) if (p) send({ content: p }, null);
  send({}, 'stop');
  res.write('data: [DONE]\n\n');
  res.end();
}

// 流式返回工具调用（OpenAI 的 chunk 格式，每个调用一块）
function chunkTools(res, calls, meta) {
  const id = 'chatcmpl-' + crypto.randomBytes(8).toString('hex');
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'connection': 'keep-alive'
  });
  const base = { id, object: 'chat.completion.chunk', created, model: meta.model || 'jingqian' };
  const send = (delta, finish) => {
    res.write('data: ' + JSON.stringify(Object.assign({}, base, {
      choices: [{ index: 0, delta, finish_reason: finish || null }]
    })) + '\n\n');
  };
  send({ role: 'assistant', content: null }, null);
  calls.forEach((c, i) => send({ tool_calls: [Object.assign({ index: i }, c)] }, null));
  send({}, 'tool_calls');
  res.write('data: [DONE]\n\n');
  res.end();
}

// 并发串行：壳可能同时发两个请求（正文 + 给会话起标题），
// 它们共用同一个临时会话，并行会互相踩历史，排队一个个来最稳。
let chain = Promise.resolve();
function serialize(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

async function handle(req, res, url, ctx) {
  const her = ctx.her;
  if (!ctx.isLocal(req)) {
    return json(res, 403, { error: { message: '这个接口只给本机用', type: 'forbidden' } });
  }

  // 开关：config.openaiApi.enabled=false 就整个关掉（默认开，但只认本机）
  const opt = (her && her.cfg && her.cfg.openaiApi) || {};
  if (opt.enabled === false) {
    return json(res, 403, {
      error: { message: '换脑接口已经关掉了（config.json 里 openaiApi.enabled=false）', type: 'forbidden' }
    });
  }
  // 可选令牌：配了就必须带，防止本机别的程序偷偷调她
  const needTok = String(opt.token || '').trim();
  if (needTok) {
    const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (got !== needTok) {
      return json(res, 401, { error: { message: '令牌不对（Authorization: Bearer <config.openaiApi.token>）', type: 'invalid_request_error' } });
    }
  }

  const p = url.pathname;

  if (p === '/v1/models' && req.method === 'GET') {
    return json(res, 200, {
      object: 'list',
      data: [
        { id: 'jingqian', object: 'model', created: 0, owned_by: 'jingqian' },
        { id: 'jingqian-chat', object: 'model', created: 0, owned_by: 'jingqian' }
      ]
    });
  }

  if (p === '/v1/chat/completions' && req.method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch (e) {
      return json(res, 400, { error: { message: e.message, type: 'invalid_request_error' } });
    }
    const text = lastUserText(body.messages);
    // 全是壳自己的噪音（比如「给这个会话起个标题」）：不打扰她，直接回空
    if (!text) {
      if (body.stream) { res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' }); res.write('data: [DONE]\n\n'); return res.end(); }
      return json(res, 200, {
        id: 'chatcmpl-noise', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
        model: body.model || 'jingqian',
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });
    }

    // 每次都是干净的一轮：历史由对方维护，这边只用记忆和人格
    try { her.saveHistory('openai', { id: 'openai', messages: [] }); } catch (e) {}
    const block = contextBlock(body.messages);

    // ---------- 外部工具（换脑第二版）----------
    // 对方把工具清单递过来，她决定调哪个；真正执行由对方做，她只拿结果继续说。
    const tools = Array.isArray(body.tools)
      ? body.tools.filter((t) => t && t.function && t.function.name).slice(0, 40)
      : [];
    const toolResults = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => m && m.role === 'tool' && m.content != null);

    let toolObservation = '';
    if (toolResults.length) {
      // 工具已经跑完了：把返回值当观察塞进去，让她据此给最终答复（不再给工具，免得来回打转）
      toolObservation = '【工具已经跑完了，这是返回值】\n'
        + toolResults.slice(-6).map((m) => '- ' + String(m.content || '').slice(0, 1500)).join('\n')
        + '\n\n（根据上面的返回值直接回答他。不要再要求调用工具，也不要假装自己执行过。）';
    }

    const input = [block, toolObservation || '', '【这次的话】\n' + text].filter(Boolean).join('\n\n');

    let reply = '';
    // 她那边要是卡住，得主动收尾：不能让对方界面一直转圈
    const timeoutMs = Math.max(15000, Number(opt.timeoutSeconds || 120) * 1000);
    const chatOpts = { sessionId: 'openai', entry: 'desktop', mode: 'chat' };
    // 有工具结果了就不再给工具；没结果又有工具清单，就让她挑。
    // 注意要按「工作模式」走：对话模式的系统提示会写「你这轮没有任何工具」，和这里冲突。
    if (!toolResults.length && tools.length) {
      chatOpts.externalTools = tools;
      chatOpts.mode = 'work';
    }

    let toolCalls = null;
    try {
      const r = await Promise.race([
        serialize(() => her.chat(input, chatOpts)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('等了 ' + Math.round(timeoutMs / 1000) + ' 秒还没答上来')), timeoutMs))
      ]);
      reply = String((r && r.reply) || '');
      if (r && Array.isArray(r.toolCalls) && r.toolCalls.length) toolCalls = r.toolCalls;
    } catch (e) {
      // 出错不甩 500：给对方一句人话，界面别卡死
      reply = '她这边没答上来：' + ((e && e.message) || e);
    }

    const usage = {
      prompt_tokens: tokenCount(input),
      completion_tokens: tokenCount(reply),
      total_tokens: tokenCount(input) + tokenCount(reply)
    };

    // 她要调工具：按 OpenAI 的格式把调用交回去，由对方执行
    if (toolCalls) {
      const norm = toolCalls.map((c, i) => ({
        id: c.id || ('call_' + crypto.randomBytes(6).toString('hex') + '_' + i),
        type: 'function',
        function: { name: c.function && c.function.name, arguments: (c.function && c.function.arguments) || '{}' }
      }));
      if (body.stream) return chunkTools(res, norm, { model: body.model });
      return json(res, 200, {
        id: 'chatcmpl-' + crypto.randomBytes(8).toString('hex'),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model || 'jingqian',
        choices: [{ index: 0, message: { role: 'assistant', content: reply || null, tool_calls: norm }, finish_reason: 'tool_calls' }],
        usage: usage
      });
    }

    if (!reply) reply = '（她这轮没说话）';

    if (body.stream) return chunk(res, reply, { model: body.model });
    return json(res, 200, {
      id: 'chatcmpl-' + crypto.randomBytes(8).toString('hex'),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'jingqian',
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      usage: usage
    });
  }

  return json(res, 404, { error: { message: '没有这个接口：' + p, type: 'invalid_request_error' } });
}

module.exports = { handle };
