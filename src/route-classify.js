'use strict';
/*
 * 分档：这一轮该走哪一档（2.0 · 分档规则）
 *
 * 三个档位：
 *   local  只走本机（隐私目录、明确不许出机器的东西）
 *   cheap  便宜的那几个（寒暄、短问题、查记忆）
 *   smart  能干硬活的那几个（长文、要工具、多步）
 *   auto   不额外干预，按原来的顺序走
 *
 * 这里只做「判断」，不碰选谁——顺序还是 router 排。
 * 用规则不用模型：规则能看、能改、判错了知道改哪一条。
 */

// 一看就知道是硬活：要动手、要多步、要长文
const HARD_WORDS = /写代码|重构|实现|调试|修(复|改)一下|部署|迁移|分析一下|总结一下这|对比|设计|方案|报错|异常|堆栈|优化|排查/;

// 明显是轻活：打招呼、问时间、问在不在
const LIGHT = /^(在吗|在不在|你好|嗨|早|晚安|晚安了|几点了|现在几点|今天几号|你是谁|你叫什么)[？?。！!]?$/;

function classifyTier(cfg, taskText, opts) {
  opts = opts || {};
  const t = String(taskText || '');

  // 1. 隐私优先：只要话里点到了隐私目录，一律不出机器
  const priv = ((cfg && cfg.privacyDirs) || []).filter(Boolean).map(String);
  if (priv.length && priv.some((d) => t.indexOf(d) >= 0)) return 'local';

  // 2. 轻活：直接走便宜的
  if (LIGHT.test(t.trim())) return 'cheap';

  // 3. 算难度
  let s = 0;
  if (t.length > 200) s += 2;
  if (opts.needTools) s += 1;
  if (HARD_WORDS.test(t)) s += 3;
  if (Number(opts.contextChars || 0) > 12000) s += 2;
  // 只有很短、又没别的信号，才算轻活（「帮我把这个模块重构一下」虽然才 11 个字，但它不轻）
  if (t.length > 0 && t.length < 8 && !opts.needTools) s -= 1;

  if (s >= 3) return 'smart';
  if (s <= -1) return 'cheap';
  return 'auto';
}

// 这个档位允许哪些提供方
function allowedByTier(tier, list) {
  if (tier === 'local') return list.filter((p) => p.tier === 'local');
  if (tier === 'cheap') {
    const cheap = list.filter((p) => p.free || p.tier === 'local');
    return cheap.length ? cheap : list;
  }
  if (tier === 'smart') {
    const cloud = list.filter((p) => p.tier !== 'local');
    return cloud.length ? cloud : list;
  }
  return list;
}

module.exports = { classifyTier, allowedByTier, HARD_WORDS, LIGHT };
