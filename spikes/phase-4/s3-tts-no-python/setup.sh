#!/usr/bin/env bash
# S3 — reproduce the frozen-Python TTS measurement.
#
# The interpreter tree and the HuggingFace cache are ~2.4 GB together, so they
# are gitignored; this script rebuilds them. Numbers it should reproduce are in
# ../README.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
worker="$repo/packages/adapter/sidecars/vieneu/worker.py"

release=20260805
asset="cpython-3.12.13+${release}-aarch64-apple-darwin-install_only_stripped.tar.gz"

cd "$here"
[ -f cpython-stripped.tar.gz ] || curl -sSL -o cpython-stripped.tar.gz \
  "https://github.com/astral-sh/python-build-standalone/releases/download/${release}/${asset}"
[ -d python ] || tar xzf cpython-stripped.tar.gz

echo "== bare interpreter =="; du -sh python

./python/bin/python3 -m pip install --disable-pip-version-check -q \
  "vieneu==3.2.4" "huggingface-hub>=0.24"

echo "== full stack =="; du -sh python
# `|| true`: ModuleNotFoundError is the CORRECT result here (the CPU stack is
# torch-free), and `set -e` would otherwise kill the script on a passing check.
echo "== torch present? =="; ./python/bin/python3 -c "import torch" 2>&1 | tail -1 || true

mkdir -p cache out
cat > req.json <<EOF
{"schemaVersion":1,"modelId":"vieneu-v3-turbo","outputDir":"$here/out","device":"cpu",
 "voice":"Minh Đức",
 "cues":[{"id":"cue1","text":"Xin chào, đây là bản thử nghiệm đóng gói VidCom trên máy chưa cài Python."}]}
EOF

# env -i is the point: no PATH to homebrew python, no inherited PYTHONPATH.
echo "== probe (no python3 on PATH) =="
env -i HOME="$here/fakehome" PATH="/usr/bin:/bin" \
  HF_HOME="$here/cache" HF_HUB_CACHE="$here/cache/hub" \
  "$here/python/bin/python3" "$worker" --probe

echo "== synthesize (cold: downloads weights) =="
time env -i HOME="$here/fakehome" PATH="/usr/bin:/bin" \
  HF_HOME="$here/cache" HF_HUB_CACHE="$here/cache/hub" \
  "$here/python/bin/python3" "$worker" --request req.json --response resp.json

echo "== weights cache =="; du -sh cache
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 out/cue1.vieneu.wav

# The prune measured in README.md: 805 MB -> 508 MB, WAV still produced.
echo "== prune candidates =="
du -sh python/lib/python3.12/site-packages/{gradio,fastapi,uvicorn,starlette,llvmlite,numba,sklearn,PIL} 2>/dev/null || true
