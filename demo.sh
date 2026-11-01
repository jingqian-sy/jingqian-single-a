#!/usr/bin/env bash
# 鲸倩 · 单A 雏版 · 30 秒演示
# 三步：记一件事 → 问回来 → 跑一条白名单命令。
# 不需要真 key：优先本机 Ollama；一个模型都没有会明确告诉你缺什么。
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "没找到 node，先装 Node.js 22+：https://nodejs.org/"
  exit 1
fi

node demo.js
