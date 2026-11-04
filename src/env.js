'use strict';
/*
 * 环境探测（2.0 · 泛用的地基）
 *
 * 别人的机器什么样都可能：有独显 / 没独显、有云 key / 没云 key、能上网 / 不能。
 * 与其让用户面对一堆配置，不如启动时探一次，给三套预设里的一套。
 *
 * 只读、只在本机跑，不发任何请求（判断云端能不能用看「有没有配 key」，不主动联网探）。
 */
const os = require('os');
const { execFileSync } = require('child_process');

function detectGpu() {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], {
      timeout: 5000, windowsHide: true
    }).toString().trim().split('\n')[0];
    const parts = out.split(',').map((s) => s.trim());
    const name = parts[0] || 'NVIDIA';
    const mb = Number(parts[1]) || 0;
    return { found: true, name: name, vramGB: Math.round((mb / 1024) * 10) / 10 };
  } catch (e) {
    return { found: false, name: '', vramGB: 0 };
  }
}

function detectLocalModel() {
  // 不联网探：只看有没有装 ollama 的可执行文件 / 默认目录在不在
  const paths = [
    process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + '\\Programs\\Ollama\\ollama.exe' : '',
    'C:\\Program Files\\Ollama\\ollama.exe',
    process.env.USERPROFILE ? process.env.USERPROFILE + '\\.ollama' : ''
  ].filter(Boolean);
  const fs = require('fs');
  for (const p of paths) { try { if (fs.existsSync(p)) return true; } catch (e) {} }
  return false;
}

function probe(cfg) {
  const gpu = detectGpu();
  const ramGB = Math.round((os.totalmem() / 1024 / 1024 / 1024) * 10) / 10;
  const providers = (cfg && cfg.providers) || [];
  const keyed = providers.filter((p) => p && p.key && String(p.key).trim() && String(p.key).indexOf('YOUR_') !== 0);
  const freeKeyed = keyed.filter((p) => p.tier === 'free');
  const cloudKeyed = keyed.filter((p) => p.tier !== 'local');
  return {
    gpu,
    ramGB,
    cpus: (os.cpus() || []).length,
    platform: process.platform,
    localModel: detectLocalModel(),
    providers: { total: providers.length, keyed: keyed.length, freeKeyed: freeKeyed.length, cloudKeyed: cloudKeyed.length },
    // 推荐哪套预设
    preset: recommend({ gpu, ramGB, localModel: detectLocalModel(), cloudKeyed: cloudKeyed.length, freeKeyed: freeKeyed.length })
  };
}

// 三套预设：省心（全云端）/ 均衡（省着用，分档）/ 质量（都用好的）
function recommend(e) {
  if (!e.gpu.found && !e.localModel) {
    return {
      name: '省心',
      reason: '没有独显也没装本地模型，全靠云端最省事',
      route: { mode: 'cloud-first', autoTier: false }
    };
  }
  if (e.gpu.found && e.gpu.vramGB >= 8 && e.localModel) {
    return {
      name: '均衡',
      reason: '显存 ' + e.gpu.vramGB + 'GB 够跑本地模型，简单活本地干、硬活上云',
      route: { mode: 'cheap-first', autoTier: true }
    };
  }
  if (e.cloudKeyed >= 1) {
    return {
      name: '质量',
      reason: '有云端 key，难的直接走云端质量最好',
      route: { mode: 'cloud-first', autoTier: false }
    };
  }
  return { name: '省心', reason: '条件有限，先用最稳的一套', route: { mode: 'cloud-first', autoTier: false } };
}

module.exports = { probe, recommend, detectGpu, detectLocalModel };
