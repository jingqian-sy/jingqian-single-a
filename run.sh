#!/usr/bin/env bash
# 鲸倩 · 单A 雏版 —— 一条命令起来（macOS / Linux）
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "没找到 node，请先装 Node.js 22+：https://nodejs.org/"
  exit 1
fi

if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "已生成 config.json（从样例复制）。要接云端就填 providers 的 key；不想填就用本机 Ollama。"
fi

mkdir -p data/workspace
exec node src/server.js
