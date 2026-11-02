'use strict';
/*
 * 自动记记忆时先判一下：这条是什么类、值几分
 *
 * 从 DSH 记忆服务的 classify / score_importance / is_emotional 搬过来的规则版，
 * 不调模型、不联网——规则看得懂、改得动，比让小模型猜稳。
 */

const EMOTION_RE = /(累|困|难过|开心|生气|害怕|焦虑|委屈|心疼|想他|想她|孤单|烦躁|心情)/;

function isEmotional(text) {
  const t = String(text || '');
  if (!t) return false;
  return EMOTION_RE.test(t) && /^我|他|她/.test(t);
}

// 判类：preference 偏好 / relation 关系与约定 / lesson 教训 / emotional 情绪 / fact 其他
function classify(text) {
  const t = String(text || '');
  if (/喜欢|讨厌|不爱|爱吃|爱喝|忌口|过敏|不吃|不喝|口味/.test(t)) return 'preference';
  if (/生日|纪念日|约定|答应|每周|每天|每年|结婚|家人|爸爸|妈妈|老爸|见面|一起/.test(t)) return 'relation';
  if (/教训|以后别|下次别|记住别|别再|别再犯|踩坑/.test(t)) return 'lesson';
  if (isEmotional(t)) return 'emotional';
  return 'fact';
}

// 判重要度（1~4）：4 = 钉住级（约定/生日/永远/一定），3 = 值得记，2 = 一般，1 = 琐事
function scoreImportance(text, source) {
  const t = String(text || '');
  let score = 2;
  if (/永远|一定|别忘|重要|必须|生日|约定|答应|过敏|忌口/.test(t)) score = 4;
  else if (classify(t) !== 'fact') score = 3;
  if (source === 'auto-capture') score = Math.min(score, 3);
  if (/^今天|^刚才|^现在|^昨天/.test(t) && score > 2) score = 2;
  return Math.max(1, Math.min(4, score));
}

module.exports = { classify, scoreImportance, isEmotional };
