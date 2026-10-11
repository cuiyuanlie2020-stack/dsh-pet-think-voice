# -*- coding: utf-8 -*-
"""把真实会话语料裁成「回放核验用」的最小载荷。

两步用法（P2-1 的验收证据就靠它，可随时复跑）：

    <bench-py> p0/replay-extractor-dump.py     # 裁语料 -> p0/out/corpus.jsonl
    <node>     p0/replay-extractor-verify.mjs  # 用我们的 JS 实现跑一遍并判定

为什么分两步：会话日志是**多帧 zstd**，Node 侧解不了（`read_across_frames`
是 Python `zstandard.stream_reader` 的参数），所以由 Python 解压裁剪、
Node 只负责跑被测实现。

隐私边界（重要）：只导出**思考文本（reasoning）与块类型**，
`text` / `tool-call` 块的正文一律丢弃 —— 既守住红线 R2（只读思考），
也让这份中间产物里不含模型的正文与工具产出。
产物落在 `p0/out/`（已 gitignore，含真实思考文本，**永不入库**）。
"""
import io
import json
import os
import sys

import zstandard as zstd

ROOT = r"C:\Users\MSI\.dsh\sessions"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "corpus.jsonl")


def load(path):
    raw = open(path, "rb").read()
    dctx = zstd.ZstdDecompressor()
    with io.BytesIO(raw) as bio, dctx.stream_reader(bio, read_across_frames=True) as r:
        return r.read().decode("utf-8", errors="replace")


def slim(data):
    """只留抽取所需字段；非 reasoning 的块只留类型，不留文本。"""
    content = []
    for b in (data.get("message") or {}).get("content") or []:
        if not isinstance(b, dict):
            continue
        if b.get("type") == "reasoning":
            content.append({"type": "reasoning", "text": b.get("text") or ""})
        else:
            content.append({"type": b.get("type")})
    stream = []
    for s in data.get("stream") or []:
        if isinstance(s, dict) and s.get("type") == "reasoning-chunks":
            stream.append({"type": "reasoning-chunks",
                           "texts": s.get("texts") or [],
                           "dt": s.get("dt") or []})
    return {"turn": data.get("turn"), "message": {"content": content}, "stream": stream}


def main():
    files = []
    for dirpath, _d, fs in os.walk(ROOT):
        for f in fs:
            if f.endswith(".jsonl.zstd"):
                files.append(os.path.join(dirpath, f))
    files.sort()
    print(f"会话文件 {len(files)} 个")

    n_out = 0
    with open(OUT, "w", encoding="utf-8") as w:
        for fp in files:
            try:
                text = load(fp)
            except Exception as e:
                print(f"  跳过 {os.path.basename(fp)}：{e}")
                continue
            for line in text.splitlines():
                if not line.strip():
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get("type") != "assistant/message":
                    continue
                w.write(json.dumps({"data": slim(o.get("data") or {})},
                                   ensure_ascii=False) + "\n")
                n_out += 1
    print(f"导出 assistant/message 载荷 {n_out} 条 → {OUT}")


if __name__ == "__main__":
    sys.exit(main())
