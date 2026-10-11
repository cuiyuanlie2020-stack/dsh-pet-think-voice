# -*- coding: utf-8 -*-
"""
P0-1 探针 A：DSH 会话轨迹（session.v4.jsonl.zstd）结构探查
目的：确认 **思考原文（reasoning）是否存在于持久化的事件流里** —— 这是 V1 的地基证据
"""
import io
import json
import sys
from collections import Counter

# 优先用 zstandard（支持 read_across_frames），退回 CPython 3.14 自带的 compression.zstd
try:
    import zstandard as zstd

    def load(path):
        raw = open(path, "rb").read()
        dctx = zstd.ZstdDecompressor()
        # read_across_frames 是 stream_reader 的参数（DSH 为追加写入的多帧格式）
        with io.BytesIO(raw) as bio, dctx.stream_reader(bio, read_across_frames=True) as r:
            return r.read()

except ImportError:
    from compression import zstd as _cz

    def load(path):
        """CPython 3.14 的 compression.zstd：按帧循环解（DSH 为追加写入的多帧格式）"""
        raw = open(path, "rb").read()
        out = bytearray()
        remaining = raw
        frames = 0
        while remaining:
            d = _cz.ZstdDecompressor()
            try:
                chunk = d.decompress(remaining)
            except Exception as e:
                print(f"  第 {frames + 1} 帧失败: {e}")
                break
            out += chunk
            frames += 1
            remaining = d.unused_data
        print(f"  共解出 {frames} 个 zstd 帧")
        return bytes(out)


def main(path):
    print(f"文件: {path}")
    data = load(path)
    if data is None:
        return
    text = data.decode("utf-8", errors="replace")
    lines = [l for l in text.splitlines() if l.strip()]
    print(f"解压后 {len(data)} 字节, {len(lines)} 行 JSONL\n")

    types = Counter()
    key_paths = Counter()
    reasoning_hits = []

    def walk(o, prefix=""):
        if isinstance(o, dict):
            for k, v in o.items():
                if k.lower() in ("reasoning", "reasoning_content", "thinking", "think", "thought"):
                    val = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)[:200]
                    reasoning_hits.append((prefix + "." + k, len(val) if isinstance(v, str) else -1, str(val)[:160]))
                if isinstance(v, (dict, list)):
                    walk(v, prefix + "." + k)
                else:
                    key_paths[prefix + "." + k] += 1
        elif isinstance(o, list):
            for i, v in enumerate(o[:5]):
                walk(v, prefix + f"[{i}]")

    for ln in lines:
        try:
            o = json.loads(ln)
        except Exception:
            types["<unparsable>"] += 1
            continue
        t = o.get("type") or o.get("kind") or "<no-type>"
        types[t] += 1
        walk(o)

    print("=== 事件类型分布（top 25）===")
    for t, c in types.most_common(25):
        print(f"  {c:5d}  {t}")

    print("\n=== 含 reasoning/thinking 字样的键（命中即 V1 成立的关键）===")
    if reasoning_hits:
        for p, ln, sample in reasoning_hits[:12]:
            print(f"  ✓ {p}  (len={ln})\n      {sample!r}")
        print(f"  … 共 {len(reasoning_hits)} 处命中")
    else:
        print("  ✗ 无命中")

    print("\n=== 键路径 top 40（看数据形状）===")
    for k, c in key_paths.most_common(40):
        print(f"  {c:6d}  {k}")


if __name__ == "__main__":
    main(sys.argv[1])
