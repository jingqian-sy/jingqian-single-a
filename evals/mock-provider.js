'use strict';
/*
 * 假模型（mock provider）：给 CI 用，不需要任何密钥。
 *
 * 它不是「智能」的，只是一台按剧本走的 OpenAI 兼容端点：
 * 看用户那句话里有啥关键词，就回固定的 tool_calls 或固定的话。
 * 目的不是测模型水平，是测**管道**：工具循环、红线、审计、路径处理、判定器。
 *
 *   node evals/mock-provider.js            # 默认 127.0.0.1:18099
 *   node evals/mock-provider.js --port 18099
 *   node evals/mock-provider.js --check    # 自检：启动、打两发、退出
 *
 * 也可以 require('./mock-provider').start({port}) 起一个在用的实例。
 */
const http = require('http');
const path = require('path');

function text(content) {
  return { role: 'assistant', content };
}

function toolCall(name, args) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: 'call_' + Math.random().toString(36).slice(2, 10),
      type: 'function',
      function: { name, arguments: JSON.stringify(args) }
    }]
  };
}

function pickAction(messages) {
  const users = messages.filter((m) => m.role === 'user').map((m) => String(m.content || ''));
  const joined = users.join('\n');
  const toolMsgs = messages.filter((m) => m.role === 'tool');
  const lastTool = toolMsgs.length ? String(toolMsgs[toolMsgs.length - 1].content || '') : '';
  return { joined, lastTool, hasTool: toolMsgs.length > 0 };
}

function firstStage(joined) {
  if (/data[\\/]workspace[\\/]prefix\.txt/i.test(joined)) {
    return { action: 'write', msg: toolCall('write_file', { path: 'data/workspace/prefix.txt', content: 'hello' }) };
  }
  if (/out\.txt/i.test(joined)) {
    return { action: 'write', msg: toolCall('write_file', { path: 'out.txt', content: 'hello 鲸倩' }) };
  }
  if (/建\s*a\.txt/i.test(joined)) {
    return {
      action: 'multi',
      msg: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: '1' }) } },
          { id: 'c2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'b.txt', content: '2' }) } },
          { id: 'c3', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'c.txt', content: '3' }) } }
        ]
      }
    };
  }
  // 通用：建一个 x.txt 写 y → 写文件（重启验证等多任务场景用）
  {
    const m = joined.match(/建(?:一个|个)?\s*([\w.-]+\.txt)[^\n]{0,8}?(?:写|内容[:：]?)\s*([^\n，。]+)/);
    if (m) return { action: 'write', msg: toolCall('write_file', { path: m[1], content: m[2].trim() }) };
  }
  if (/format\s+[a-z]:/i.test(joined) || /diskpart/i.test(joined)) {
    return { action: 'danger', msg: toolCall('run_command', { command: 'format D: /q' }) };
  }
  if (/echo[^\n]*/i.test(joined)) {
    return { action: 'command', msg: toolCall('run_command', { command: 'echo 鲸倩演示通过' }) };
  }
  if (/(记一下|记住|别忘)/.test(joined) && /羽毛球/.test(joined)) {
    return { action: 'remember', msg: toolCall('remember', { text: '我每周三晚上打羽毛球', kind: 'fact', importance: 3 }) };
  }
  if (/周三[^\n]*干嘛|一般干嘛/.test(joined)) {
    return { action: 'recall', msg: text('你每周三晚上打羽毛球呀。') };
  }
  if (/羽毛球/.test(joined)) {
    return { action: 'recall', msg: text('你每周三晚上打羽毛球呀。') };
  }
  return { action: 'plain', msg: text('好。') };
}

function secondStage(action, lastTool) {
  if (action === 'remember') return text('记住了：每周三晚上打羽毛球。');
  if (action === 'write') return text('写好了。');
  if (action === 'multi') return text('三个文件都建好了。');
  if (action === 'command') return text('跑了，输出是：鲸倩演示通过。');
  if (action === 'danger') {
    if (/红线|P0|拦|不做/.test(lastTool)) return text('不做。这个操作被红线拦下了（P0），你自己来。');
    return text('没跑，这种操作我不碰。');
  }
  return text('好。');
}

function respond(messages) {
  const { joined, lastTool, hasTool } = pickAction(messages);
  const stage = firstStage(joined);
  if (hasTool && ['write', 'multi', 'command', 'danger', 'remember'].includes(stage.action)) {
    return secondStage(stage.action, lastTool);
  }
  return stage.msg;
}

function start(opts) {
  opts = opts || {};
  const port = Number(opts.port || process.env.MOCK_PORT || 18099);
  const host = opts.host || '127.0.0.1';
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, mock: true, port }));
    }
    if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'mock: 只支持 POST /v1/chat/completions' } }));
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (e) {}
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const msg = respond(messages);
      const promptTokens = Math.ceil(raw.length / 4);
      const completionTokens = 24;
      const payload = {
        id: 'mock-' + Date.now(),
        object: 'chat.completion',
        model: body.model || 'mock-1',
        choices: [{ index: 0, message: msg, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
      };
      const out = JSON.stringify(payload);
      const delay = Number(process.env.MOCK_DELAY_MS || 0);
      const sendIt = () => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
        res.end(out);
      };
      if (delay > 0) setTimeout(sendIt, delay); else sendIt();
    });
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, port, close: () => server.close() })));
}

module.exports = { start, respond };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const portArg = argv.includes('--port') ? Number(argv[argv.indexOf('--port') + 1]) : 18099;
  start({ port: portArg }).then(async (h) => {
    console.log('mock provider 起在 http://127.0.0.1:' + h.port + '/v1/chat/completions');
    if (argv.includes('--check')) {
      const one = await fetch('http://127.0.0.1:' + h.port + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: '建一个 out.txt，里面写：hello' }] })
      });
      const j = await one.json();
      const name = j.choices[0].message.tool_calls[0].function.name;
      console.log('自检：' + (name === 'write_file' ? '通过' : '失败（' + name + '）'));
      h.close();
      process.exit(name === 'write_file' ? 0 : 1);
    }
  });
}
