'use strict';
// 共用内核（E1）：3A 的选路直接用 1A 的 Router（重试、冷却、按天账本都跟着一起升级）
// 3A 编排只依赖 call() 返回的 json / provider / stat / elapsed_ms，1A 是它的超集。
module.exports = require('../src/router');
