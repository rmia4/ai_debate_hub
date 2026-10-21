#!/bin/sh
# OpenAI 플러그인 제출용 ZIP을 만든다.
# 커밋된 패키지 파일만 ZIP 최상위에 담고, 로컬 마켓플레이스(.agents/)와 이 스크립트는 넣지 않는다.
set -e
cd "$(dirname "$0")"
version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' plugin.json)
mkdir -p dist
git archive --format=zip -o "dist/ai-debate-$version.zip" HEAD plugin.json mcp.json assets
echo "dist/ai-debate-$version.zip"
