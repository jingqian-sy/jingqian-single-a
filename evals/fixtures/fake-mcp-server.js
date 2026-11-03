'use strict';
// 测试用假 MCP 服务：只回 initialize / tools/list / tools/call
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    if (msg.id === undefined) continue; // 通知不用回
    const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    if (msg.method === 'initialize') {
      send({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0' } });
    } else if (msg.method === 'tools/list') {
      send({
        tools: [
          { name: 'hello', description: 'say hello', inputSchema: { type: 'object', properties: { who: { type: 'string' } } } },
          { name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }
        ]
      });
    } else if (msg.method === 'tools/call') {
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      if (name === 'hello') send({ content: [{ type: 'text', text: '你好，' + (args.who || '世界') }] });
      else if (name === 'echo') send({ content: [{ type: 'text', text: 'ECHO:' + (args.text || '') }] });
      else send({ isError: true, content: [{ type: 'text', text: '没有这个工具' }] });
    } else {
      send({});
    }
  }
});
