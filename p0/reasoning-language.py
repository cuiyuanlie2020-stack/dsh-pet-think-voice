# -*- coding: utf-8 -*-
"""量**思考（reasoning）的语种** —— D10 的判据工具。

用途：
  1. 看默认情况下思考是什么语种（基线）
  2. 装了「语言注入」类插件后，**验证它是否真的生效**（对比前后）
  3. 日常抽查：某次改动有没有让思考语言漂回英文

为什么单独有思考口径：**回复的语言 ≠ 思考的语言**。用户用中文问，回复本来就
会是中文（实测回复中文占比 0.75~0.84），但思考仍可能是英文（0.07~0.35）。
只看回复会得出"没问题"的错误结论。

用法：
    <bench-py> p0/reasoning-language.py [会话数，默认 6]

⚠️ 会话日志含真实对话内容 → 本脚本**只输出统计量**（字数、中文占比），不打印任何文本。
"""
import io
import json
import os
import sys
import time

import zstandard as zstd

ROOT = r"C:\Users\MSI\.dsh\sessions"


def load(path):
    raw = open(path, "rb").read()
    dctx = zstd.ZstdDecompressor()
    with io.BytesIO(raw) as bio, dctx.stream_reader(bio, read_across_frames=True) as r:
        return r.read().decode("utf-8", errors="replace")


def cjk(s):
    return sum(1 for ch in s if "\u4e00" <= ch <= "\u9fff")


def latin(s):
    return sum(1 for ch in s if ch.isascii() and ch.isalpha())


def ratio(s):
    c, l = cjk(s), latin(s)
    return 0.0 if c + l == 0 else c / (c + l)


def blocks(data):
    for b in (data.get("message") or {}).get("content") or []:
        if isinstance(b, dict):
            yield b.get("type"), b.get("text") or ""


def scan(path):
    """返回 [(kind, 字数, 中文占比)]，kind ∈ {思考, 回复}"""
    rows = []
    for line in load(path).splitlines():
        if not line.strip():
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get("type") != "assistant/message":
            continue
        for typ, txt in blocks(o.get("data") or {}):
            if not txt.strip():
                continue
            if typ == "reasoning":
                rows.append(("思考", len(txt), ratio(txt)))
            elif typ == "text":
                rows.append(("回复", len(txt), ratio(txt)))
    return rows


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    files = []
    for dirpath, _d, fs in os.walk(ROOT):
        for f in fs:
            if f.endswith(".jsonl.zstd"):
                files.append(os.path.join(dirpath, f))
    files.sort(key=os.path.getmtime, reverse=True)

    print("最近 %d 个会话的思考语种（中文占比：0=全英，1=全中）\n" % limit)
    allr = []
    for fp in files:
        rows = scan(fp)
        if not rows:
            continue
        ts = time.strftime("%m-%d %H:%M", time.localtime(os.path.getmtime(fp)))
        print("  [%s] %s" % (ts, os.path.basename(os.path.dirname(fp))[:36]))
        for kind, n, r in rows:
            bar = "英" * int(round((1 - r) * 10)) + "中" * int(round(r * 10))
            print("      %s %6d 字  中文占比 %.2f  |%s|" % (kind, n, r, bar))
            if kind == "思考":
                allr.append(r)
        limit -= 1
        if limit <= 0:
            break

    if allr:
        mean = sum(allr) / len(allr)
        zh = sum(1 for r in allr if r > 0.3)
        print("\n  合计 %d 条思考：平均中文占比 %.2f，中文主导 %d/%d (%.0f%%)"
              % (len(allr), mean, zh, len(allr), 100.0 * zh / len(allr)))
        print("\n  参考基线（P2 语料 213 条真实思考）：均值 0.05~0.09，中文主导仅 5.2%")
        print("  若装了语言注入插件，这里应显著高于基线（实测可达 0.58~0.88）")


if __name__ == "__main__":
    sys.exit(main())
