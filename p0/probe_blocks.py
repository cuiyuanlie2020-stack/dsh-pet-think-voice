# -*- coding: utf-8 -*-
"""
P0-1 探针 B：判定思考原文是否存在及其存放位置
枚举 assistant/message 事件里的内容块类型 / 流式块类型，并打印真实样本
"""
import io
import json
import sys
from collections import Counter

import zstandard as zstd


def load(path):
    raw = open(path, "rb").read()
    dctx = zstd.ZstdDecompressor()
    with io.BytesIO(raw) as bio, dctx.stream_reader(bio, read_across_frames=True) as r:
        return r.read().decode("utf-8", errors="replace")


def main(path):
    lines = [l for l in load(path).splitlines() if l.strip()]
    ev = []
    for ln in lines:
        try:
            ev.append(json.loads(ln))
        except Exception:
            pass

    content_types = Counter()
    block_types = Counter()
    chunk_types = Counter()
    chunk_block_types = Counter()
    role_counter = Counter()
    src_kind = Counter()
    samples = {}

    for o in ev:
        if o.get("type") != "assistant/message":
            continue
        m = (o.get("data") or {}).get("message") or {}
        role_counter[m.get("role")] += 1
        src = m.get("source") or {}
        src_kind[src.get("kind")] += 1

        for c in m.get("content") or []:
            if isinstance(c, dict):
                content_types[c.get("type")] += 1
                samples.setdefault("content." + str(c.get("type")), json.dumps(c, ensure_ascii=False)[:300])

        rs = src.get("replayState") or {}
        for b in rs.get("blocks") or []:
            if isinstance(b, dict):
                block_types[b.get("type")] += 1
                samples.setdefault("replayBlock." + str(b.get("type")), json.dumps(b, ensure_ascii=False)[:300])

        for s in (o.get("data") or {}).get("stream") or []:
            ch = (s or {}).get("chunk") or {}
            chunk_types[ch.get("type")] += 1
            if ch.get("blockType"):
                chunk_block_types[ch["blockType"]] += 1
            samples.setdefault("chunk." + str(ch.get("type")), json.dumps(s, ensure_ascii=False)[:300])

    print(f"assistant/message 事件数: {role_counter.total()}")
    print(f"  role: {dict(role_counter)}")
    print(f"  source.kind: {dict(src_kind)}\n")

    print("=== content[].type 取值 ===")
    for k, v in content_types.most_common():
        print(f"  {v:4d}  {k}")
    print("\n=== replayState.blocks[].type 取值 ===")
    for k, v in block_types.most_common():
        print(f"  {v:4d}  {k}")
    print("\n=== stream[].chunk.type 取值 ===")
    for k, v in chunk_types.most_common():
        print(f"  {v:4d}  {k}")
    print("\n=== stream[].chunk.blockType 取值（★ 关键）===")
    for k, v in chunk_block_types.most_common():
        print(f"  {v:4d}  {k}")

    print("\n=== 样本 ===")
    for k, v in samples.items():
        print(f"\n[{k}]\n  {v}")

    # 明确判定
    print("\n===== 判定 =====")
    hit = [k for k in list(block_types) + list(chunk_block_types) + list(content_types)
           if k and any(w in str(k).lower() for w in ("reason", "think", "thought"))]
    if hit:
        print(f"  ✅ 命中思考类内容块类型: {sorted(set(hit))}  → V1 成立（数据里确实有思考原文）")
    else:
        print("  ❌ 未命中思考类类型名——需进一步看 content 文本是否含思考内容")


if __name__ == "__main__":
    main(sys.argv[1])
