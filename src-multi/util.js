'use strict';
// 共用内核（E1）：3A 不再自带一份，直接用 1A 的实现
// 原来的设计决定是「共用协议、不共用实现」，这个决定在 2026-11-03 改了：
// 两份实现各改一遍代价太大，改成共用底层（util/safety/sandbox），3A 只保留编排差异。
module.exports = require('../src/util');
