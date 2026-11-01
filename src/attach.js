'use strict';
/*
 * 附件：把拖进输入栏的文件变成「能塞进对话的东西」。
 *
 * 两类处理：
 *   - 文本类（.txt .md .js .json .log .csv .cs .py ... 或者看着就是 UTF-8 的）：读内容，限制大小，
 *     超了截断并明说「只看了前 N KB」——绝不假装读全了；
 *   - 图片（.png .jpg .jpeg .gif .webp .bmp）：读成 data URL 交给 supportsVision 的模型；
 *     当前模型不支持看图时，由上层给一句实话，而不是硬塞。
 *
 * 其余（压缩包、exe、太大的文件）：只登记名字和大小，不读内容。
 * 红线：只读本地文件；路径由用户拖进来，不主动扫目录、不传网络。
 */
const fs = require('fs');
const path = require('path');

const IMG_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
};

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.js', '.cjs', '.mjs', '.ts', '.css',
  '.html', '.htm', '.xml', '.yml', '.yaml', '.ini', '.cfg', '.conf', '.log', '.csv',
  '.tsv', '.py', '.cs', '.java', '.c', '.h', '.cpp', '.go', '.rs', '.sh', '.ps1',
  '.bat', '.cmd', '.sql', '.toml'
]);

const DEFAULTS = {
  maxFiles: 6,
  maxTextBytes: 200000,   // 单文件 200 KB 文本
  maxImageBytes: 6 * 1024 * 1024,
  maxTotalBytes: 24 * 1024 * 1024
};

function human(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function classify(p) {
  const ext = path.extname(p).toLowerCase();
  if (IMG_MIME[ext]) return 'image';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'other';
}

/**
 * @param {string[]} paths
 * @param {object} opts {maxFiles,maxTextBytes,maxImageBytes,maxTotalBytes,fsImpl}
 * @returns {{files:Array, images:Array, block:string, skipped:Array}}
 */
function describe(paths, opts) {
  opts = opts || {};
  const maxFiles = opts.maxFiles || DEFAULTS.maxFiles;
  const maxTextBytes = opts.maxTextBytes || DEFAULTS.maxTextBytes;
  const maxImageBytes = opts.maxImageBytes || DEFAULTS.maxImageBytes;
  const maxTotalBytes = opts.maxTotalBytes || DEFAULTS.maxTotalBytes;
  const list = Array.isArray(paths) ? paths : (paths ? [paths] : []);
  const files = [];
  const images = [];
  const skipped = [];
  let total = 0;

  for (const raw of list) {
    if (files.length + images.length >= maxFiles) {
      skipped.push({ path: String(raw || ''), reason: '一次最多带 ' + maxFiles + ' 个附件' });
      continue;
    }
    const p = String(raw || '');
    if (!p) continue;
    let st;
    try { st = fs.statSync(p); } catch (e) {
      skipped.push({ path: p, reason: '文件不存在或没权限：' + (e.code || e.message) });
      continue;
    }
    if (st.isDirectory()) { skipped.push({ path: p, reason: '这是一整个文件夹，先打包或者拖单个文件' }); continue; }
    const name = path.basename(p);
    const kind = classify(p);
    const size = st.size;
    if (size > maxTotalBytes) { skipped.push({ path: p, reason: '单文件超过 ' + human(maxTotalBytes) + '，太大了' }); continue; }
    total += size;

    if (kind === 'image') {
      if (size > maxImageBytes) { skipped.push({ path: p, reason: '图片超过 ' + human(maxImageBytes) + '，先压缩一下' }); continue; }
      try {
        const buf = fs.readFileSync(p);
        const mime = IMG_MIME[path.extname(p).toLowerCase()];
        const dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
        const item = { path: p, name: name, size: size, kind: 'image', mime: mime, dataUrl: dataUrl };
        files.push(item);
        images.push({ name: name, mime: mime, dataUrl: dataUrl, size: size });
      } catch (e) {
        skipped.push({ path: p, reason: '读不了这张图：' + e.message });
      }
      continue;
    }

    if (kind === 'text') {
      try {
        const buf = fs.readFileSync(p);
        if (looksBinary(buf)) {
          files.push({ path: p, name: name, size: size, kind: 'other', note: '看着像二进制文件，没读内容' });
          continue;
        }
        const cut = buf.length > maxTextBytes;
        const text = buf.slice(0, maxTextBytes).toString('utf8');
        files.push({
          path: p, name: name, size: size, kind: 'text',
          text: text,
          truncated: cut,
          textBytes: Math.min(buf.length, maxTextBytes)
        });
      } catch (e) {
        skipped.push({ path: p, reason: '读不了这个文件：' + e.message });
      }
      continue;
    }

    files.push({ path: p, name: name, size: size, kind: 'other', note: '这个格式不读内容，只记名字' });
  }

  // 拼成给模型看的附件块（只带文本；图片走 images 字段）
  const parts = [];
  for (const f of files) {
    if (f.kind === 'text') {
      parts.push('【附件：' + f.name + '（' + human(f.size) + '）' +
        (f.truncated ? '，只看了前 ' + human(f.textBytes) + '，后面截掉了' : '') + '】\n' + f.text + '\n【附件结束】');
    } else {
      parts.push('【附件：' + f.name + '（' + human(f.size) + '，' + (f.note || '没有读内容') + '）】');
    }
  }
  return { files: files, images: images, block: parts.join('\n\n'), skipped: skipped, totalBytes: total };
}

function describeNames(paths) {
  return (Array.isArray(paths) ? paths : []).map((p) => path.basename(String(p || ''))).filter(Boolean);
}

module.exports = { describe, describeNames, looksBinary, classify, human, IMG_MIME, TEXT_EXT, DEFAULTS };
