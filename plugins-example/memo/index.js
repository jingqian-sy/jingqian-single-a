'use strict';
/*
 * 最小插件示例：随手记
 *
 * 记下来的东西存在插件自己的目录里（ctx.dataDir），不碰主程序的记忆库。
 * 想验证插件装好没有：在设置 → 插件里点「看看便签」，或者让模型调用 memo_add。
 */
const fs = require('fs');
const path = require('path');

module.exports = function (ctx) {
  const file = path.join(ctx.dataDir, 'memo.json');

  const load = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || []; } catch (e) { return []; }
  };
  const save = (list) => fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf8');

  ctx.log('随手记插件加载了，数据目录：' + ctx.dataDir);

  ctx.registerTool({
    name: 'memo_add',
    description: '往插件便签里记一条（和主程序的记忆库分开）'
  }, {
    type: 'object',
    properties: { text: { type: 'string', description: '要记的一句话' } },
    required: ['text']
  }, function (args) {
    const text = String((args && args.text) || '').trim();
    if (!text) return '没什么可记的。';
    const list = load();
    list.push({ text: text.slice(0, 200), at: new Date().toISOString() });
    save(list);
    return '记进便签了：' + text.slice(0, 60) + '（现在 ' + list.length + ' 条）';
  });

  ctx.registerTool({
    name: 'memo_list',
    description: '把插件便签里的内容列出来'
  }, { type: 'object', properties: { limit: { type: 'integer' } } }, function (args) {
    const list = load();
    if (!list.length) return '便签还是空的。';
    const n = Math.min(Number((args && args.limit) || 10), 50);
    return list.slice(-n).map((x) => '- ' + x.text).join('\n');
  });

  // 本机接口：GET /api/plugin/memo/stats
  ctx.registerRoute('GET', 'stats', function () {
    const list = load();
    return { count: list.length, latest: list.length ? list[list.length - 1].text : '' };
  });

  // 界面按钮：设置 → 插件里点「看看便签」
  ctx.ui = {
    label: '看看便签',
    run: function () {
      const list = load();
      if (!list.length) return '便签还是空的，让模型说一句「记到便签：……」试试。';
      return '便签里有 ' + list.length + ' 条：\n' + list.slice(-5).map((x) => '- ' + x.text).join('\n');
    }
  };

  return { title: '随手记', loadedAt: new Date().toISOString() };
};
