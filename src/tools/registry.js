'use strict';
/*
 * 工具契约（2.0 · M1 的第一步）
 *
 * 目的：把「有哪些工具」和「这次给哪几个」分开。
 *
 * 以前是 defs() 一把梭：要么全给，要么按 config.tools.names 卡死。
 * 现在多一层「场景」：
 *   - 对话模式一个都不给
 *   - 只读场景只给看得见的
 *   - 干活场景才给能写能跑的
 *   - 还可以按模型指定（小模型只给两三个，大模型全给）
 *
 * 这一层只做筛选和转发，不改任何工具的实现——所以不会把现有功能改坏。
 * 以后外部工具（MCP / 插件）也走同一条 invoke()，那就是完整的契约了。
 */

// 内置场景。用户在 config.tools.profiles 里可以覆盖任意一项。
const DEFAULT_PROFILES = {
  chat: [],
  readonly: [
    'read_file', 'list_dir', 'recall', 'search_history', 'fetch_url',
    'event_timeline'
  ],
  code: ['read_file', 'write_file', 'list_dir', 'run_command', 'recall'],
  all: null          // null = 不额外限制，交给原有配置
};

class ToolRegistry {
  constructor(tools) {
    this.tools = tools;        // Tools 实例（不改它，只借用 defs / run）
  }

  cfg() {
    return (this.tools && this.tools.ctx && this.tools.ctx.cfg) || {};
  }

  // 配置里能覆盖场景；写 null 表示「这个场景不限制」
  profiles() {
    const user = (this.cfg().tools && this.cfg().tools.profiles) || {};
    return Object.assign({}, DEFAULT_PROFILES, user);
  }

  // 这个模型名字该用哪个场景（config.tools.modelProfiles）
  profileForModel(modelName) {
    const m = (this.cfg().tools && this.cfg().tools.modelProfiles) || {};
    const k = String(modelName || '').trim();
    if (!k) return null;
    for (const key of Object.keys(m)) {
      if (k.indexOf(key) >= 0) return m[key];
    }
    return null;
  }

  // 按场景取工具定义（OpenAI function 格式）
  defs(profile) {
    const all = this.tools.defs();          // 原有的全量（已含 features 开关）
    if (profile == null) return all;
    const p = this.profiles();
    if (!(profile in p)) return all;        // 不认识的场景：退回全量，别把功能弄没
    const allow = p[profile];
    if (allow === null) return all;
    if (!Array.isArray(allow)) return all;
    const set = new Set(allow.map(String));
    return all.filter((d) => set.has(d.function.name));
  }

  names(profile) {
    return this.defs(profile).map((d) => d.function.name);
  }

  has(name) {
    return this.tools.defs().some((d) => d.function.name === name);
  }

  // 统一入口：不管内置、插件还是以后的外部工具，都从这儿走
  async invoke(name, args, opts) {
    if (!this.has(name)) return '没有这个工具：' + name;
    return await this.tools.run(name, args, opts);
  }

  // 给界面/日志看：每个场景各几个工具
  summary() {
    const out = {};
    for (const k of Object.keys(this.profiles())) {
      out[k] = this.names(k).length;
    }
    return out;
  }
}

module.exports = { ToolRegistry, DEFAULT_PROFILES };
