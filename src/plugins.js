'use strict';
/*
 * 插件模组：把自己的小功能装进来，不用改核心代码
 *
 * 一个插件就是一个目录，放在 data/plugins/<名字>/：
 *   plugin.json   清单（名字、版本、要哪些权限）
 *   index.js      入口，导出一个函数：module.exports = function (ctx) { ... }
 *
 * 插件能拿到的东西（就这些，别的碰不到）：
 *   ctx.name / ctx.title / ctx.dataDir   自己的名字和私有数据目录（自动建好）
 *   ctx.log(msg)                         写 data/plugins.log
 *   ctx.registerTool(desc, params, fn)   注册一个模型能调用的工具
 *   ctx.registerRoute(method, path, fn)  注册本机接口 /api/plugin/<名字>/<path>
 *   ctx.memory.add(text, opts)           写一条记忆（和主程序同一个记忆库）
 *   ctx.memory.search(query)             搜记忆
 *   ctx.ui = { label, run }              界面里给一个按钮，点了跑 run()
 *
 * 权限要在 plugin.json 的 permissions 里写明（tool / route / ui / memory），
 * 没声明的调用会直接报错。
 *
 * 说清楚风险：这一版是「可信插件」——插件和服务同一个进程、同样的权限，
 * 一个写坏的插件能把整个服务搞挂，也能读本机文件。只装你自己看过、信得过的插件。
 * 真正的隔离（worker + 权限代理）是下一步，不是这一版。
 */
const fs = require('fs');
const path = require('path');
const { readJson, writeJson, ensureDir, appendJsonl } = require('./util');

const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const PERMISSIONS = ['tool', 'route', 'ui', 'memory'];

function pluginsDir(dataDir) {
  return path.join(dataDir, 'plugins');
}

function readManifest(dir) {
  const file = path.join(dir, 'plugin.json');
  let m = null;
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { error: 'plugin.json 读不出来或不是合法 JSON' }; }
  if (!m || typeof m !== 'object') return { error: 'plugin.json 不是对象' };
  const name = String(m.name || '');
  if (!NAME_RE.test(name)) return { error: '插件名只能小写字母/数字/-/_，2~32 位' };
  const main = String(m.main || 'index.js');
  const abs = path.resolve(dir, main);
  if (!abs.startsWith(path.resolve(dir) + path.sep) && abs !== path.resolve(dir)) return { error: '入口文件不许指到插件目录外面' };
  if (!fs.existsSync(abs)) return { error: '找不到入口文件：' + main };
  const perms = Array.isArray(m.permissions) ? m.permissions.map(String) : [];
  const bad = perms.filter((p) => PERMISSIONS.indexOf(p) < 0);
  if (bad.length) return { error: '不认识的权限：' + bad.join('、') + '（只支持 ' + PERMISSIONS.join(' / ') + '）' };
  return {
    name: name,
    title: String(m.title || name),
    version: String(m.version || '0.0.0'),
    description: String(m.description || ''),
    author: String(m.author || ''),
    permissions: perms,
    main: abs,
    ui: (m.ui && typeof m.ui === 'object' && m.ui.label) ? { label: String(m.ui.label) } : null
  };
}

class PluginHost {
  constructor(opts) {
    opts = opts || {};
    this.dataDir = opts.dataDir;
    this.cfg = opts.cfg || {};
    this.configPath = opts.configPath;
    this.tools = opts.tools;
    this.store = opts.store;
    this.dir = pluginsDir(this.dataDir);
    this.logFile = path.join(this.dataDir, 'plugins.log');
    ensureDir(this.dir);
    this.loaded = {};   // name -> { manifest, meta, routes: [], ui, error }
    this.lastError = {};
  }

  // 已安装清单（不加载），给界面和接口看
  list() {
    const out = [];
    let dirs = [];
    try { dirs = fs.readdirSync(this.dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); }
    catch (e) { return out; }
    const enabled = this.enabledList();
    for (const d of dirs) {
      const abs = path.join(this.dir, d);
      const m = readManifest(abs);
      if (m.error) {
        out.push({ name: d, title: d, version: '', description: '', permissions: [], dir: abs, enabled: false, loaded: false, error: m.error });
        continue;
      }
      const isOn = enabled.indexOf(m.name) >= 0;
      const st = this.loaded[m.name];
      out.push({
        name: m.name,
        title: m.title,
        version: m.version,
        description: m.description,
        author: m.author,
        permissions: m.permissions,
        ui: m.ui ? m.ui.label : '',
        dir: abs,
        enabled: isOn,
        loaded: !!(st && !st.error),
        error: (st && st.error) || ''
      });
    }
    return out;
  }

  enabledList() {
    const p = (this.cfg && this.cfg.plugins) || {};
    return Array.isArray(p.enabled) ? p.enabled.map(String) : [];
  }

  setEnabled(name, on) {
    const p = Object.assign({ enabled: [] }, this.cfg.plugins || {});
    const list = Array.isArray(p.enabled) ? p.enabled.map(String) : [];
    const i = list.indexOf(name);
    if (on && i < 0) list.push(name);
    if (!on && i >= 0) list.splice(i, 1);
    p.enabled = list;
    this.cfg.plugins = p;
    if (this.configPath) {
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(this.configPath, 'utf8')); } catch (e) { cur = {}; }
      cur.plugins = p;
      fs.writeFileSync(this.configPath, JSON.stringify(cur, null, 2), 'utf8');
    }
    return list;
  }

  log(event, detail) {
    try { appendJsonl(this.logFile, { ts: new Date().toISOString(), event, detail: detail || {} }); } catch (e) {}
  }

  // 加载所有「已启用」的插件；单个插件出错只影响它自己
  load() {
    if (this.tools && typeof this.tools.clearPluginTools === 'function') this.tools.clearPluginTools();
    this.loaded = {};
    const enabled = this.enabledList();
    for (const name of enabled) {
      const dir = path.join(this.dir, name);
      if (!fs.existsSync(dir)) { this.log('启用但目录不存在', { name }); continue; }
      const m = readManifest(dir);
      if (m.error) { this.loaded[name] = { error: m.error }; this.log('清单有错', { name, error: m.error }); continue; }
      if (m.name !== name) { this.loaded[name] = { error: '目录名和插件名不一致（目录 ' + name + '，清单 ' + m.name + '）' }; this.log('名字不一致', { name }); continue; }
      try {
        const state = { manifest: m, routes: [], ui: null, meta: null, error: '' };
        const api = this.makeApi(m, state);
        delete require.cache[require.resolve(m.main)];
        const mod = require(m.main);
        if (typeof mod !== 'function') throw new Error('index.js 要导出一个函数：module.exports = function (ctx) { ... }');
        const meta = mod(api);
        state.meta = meta || {};
        this.loaded[name] = state;
        this.log('已加载', { name, version: m.version, tools: Object.keys(state.tools || {}) });
      } catch (e) {
        this.loaded[name] = { error: e.message };
        this.lastError[name] = e.message;
        this.log('加载失败', { name, error: e.message });
      }
    }
    return this.loaded;
  }

  makeApi(m, state) {
    const self = this;
    const has = (p) => m.permissions.indexOf(p) >= 0;
    const pluginData = path.join(this.dir, m.name, 'data');
    ensureDir(pluginData);
    const need = (p) => {
      if (!has(p)) throw new Error('插件 ' + m.name + ' 没有声明 ' + p + ' 权限（plugin.json 的 permissions）');
    };
    state.tools = {};
    const api = {
      name: m.name,
      title: m.title,
      version: m.version,
      dataDir: pluginData,
      log: (msg) => self.log('插件日志', { plugin: m.name, msg: String(msg).slice(0, 500) }),
      registerTool: (desc, params, fn) => {
        need('tool');
        const n = (desc && desc.name) || '';
        if (!NAME_RE.test(String(n))) throw new Error('工具名不合法：' + n);
        if (typeof fn !== 'function') throw new Error('registerTool 第三个参数要是函数');
        if (self.tools && typeof self.tools.registerPluginTool === 'function') {
          self.tools.registerPluginTool({ name: n, description: String((desc && desc.description) || ''), parameters: params || { type: 'object', properties: {} } }, m.name, fn);
        }
        state.tools[n] = true;
        return n;
      },
      registerRoute: (method, p, fn) => {
        need('route');
        if (typeof fn !== 'function') throw new Error('registerRoute 第三个参数要是函数');
        state.routes.push({ method: String(method || 'GET').toUpperCase(), path: String(p || '/').replace(/^\/+/, ''), fn });
      },
      memory: {
        add: (text, opts) => {
          need('memory');
          return self.store ? self.store.add(Object.assign({ text: String(text || ''), source: 'plugin:' + m.name }, opts || {})) : null;
        },
        search: (q, topK) => {
          need('memory');
          if (!self.store) return [];
          return self.store.active().filter((x) => String(x.text || '').indexOf(String(q || '')) >= 0).slice(0, topK || 5);
        }
      }
    };
    // 界面按钮：插件自己挂一个 ui 对象（ui.label + ui.run），这里只做校验
    Object.defineProperty(api, 'ui', {
      set: (v) => {
        need('ui');
        if (!v || !v.label || typeof v.run !== 'function') throw new Error('ui 要写成 { label, run }');
        state.ui = { label: String(v.label) };
        state.uiRun = v.run;
      },
      get: () => state.ui,
      enumerable: true,
      configurable: true
    });
    return api;
  }

  // /api/plugin/<name>/<rest>
  route(name, method, rest) {
    const st = this.loaded[name];
    if (!st || st.error) return null;
    const p = String(rest || '').replace(/^\/+/, '');
    for (const r of st.routes) {
      if (r.method !== String(method || 'GET').toUpperCase()) continue;
      if (r.path === p || r.path === '/' + p) return r.fn;
    }
    return null;
  }

  async callUi(name, body) {
    const st = this.loaded[name];
    if (!st || st.error) throw new Error(st ? st.error : '插件没加载');
    if (!st.uiRun) throw new Error('这个插件没有界面按钮');
    return await st.uiRun(body || {});
  }

  // 从本地目录装插件（复制进 data/plugins/<名字>）；不联网
  install(srcDir) {
    const src = path.resolve(String(srcDir || ''));
    if (!fs.existsSync(src)) return { ok: false, error: '目录不存在：' + src };
    const m = readManifest(src);
    if (m.error) return { ok: false, error: m.error };
    const dest = path.join(this.dir, m.name);
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    copyDir(src, dest);
    this.log('已安装', { name: m.name, from: src });
    return { ok: true, name: m.name, title: m.title, version: m.version };
  }

  uninstall(name) {
    if (!NAME_RE.test(String(name))) return { ok: false, error: '插件名不合法' };
    const dir = path.join(this.dir, String(name));
    if (!fs.existsSync(dir)) return { ok: false, error: '没装这个插件' };
    this.setEnabled(String(name), false);
    fs.rmSync(dir, { recursive: true, force: true });
    this.log('已卸载', { name });
    return { ok: true, name };
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const d of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, d.name);
    const b = path.join(dest, d.name);
    if (d.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

module.exports = { PluginHost, pluginsDir, readManifest, PERMISSIONS, NAME_RE };
