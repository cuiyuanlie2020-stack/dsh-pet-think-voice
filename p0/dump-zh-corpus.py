# -*- coding: utf-8 -*-
"""导出**中文/混合**思考语料 —— D11 / P4-1 中文重校的取数脚本。

为什么需要单独一份：全量语料里英文占 69%（`p0/replay-extractor-dump.py` 导的就是全量），
而 D11 的现象是"中文注入生效后选不出片段"—— 只有把**中文那一小撮**单独拎出来，
才能看清中文侧的词表缺口。P4-1 的全部结论都出自这份语料。

用法（两步）：
    <bench-py> p0/dump-zh-corpus.py      # 本脚本 → p0/out/corpus-zh.jsonl
    <node>     p0/zh-calibrate.mjs       # 中文口径诊断

判定阈值：`中文占比 = 汉字 / (汉字 + 拉丁字母) > 0.05` 就算"中文/混合"。
（为什么不用 0.3：注入生效后常有"英文夹中文"的混合思考，漏掉它们会低估中文素材量。）

隐私边界（红线 R2）：只导出 **reasoning 块**，`text` / `tool-call` 正文一律丢弃。
产物含真实思考文本 → 落 `p0/out/`（已 gitignore，**永不入库**）。
"""
import io
import json
import os
import sys

import zstandard as zstd

ROOT = r"C:\Users\MSI\.dsh\sessions"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "corpus-zh.jsonl")


def load(path):
    """会话日志是**多帧 zstd** —— `read_across_frames` 是 stream_reader 的参数。"""
    raw = open(path, "rb").read()
    dctx = zstd.ZstdDecompressor()
    with io.BytesIO(raw) as bio, dctx.stream_reader(bio, read_across_frames=True) as r:
        return r.read().decode("utf-8", errors="replace")


def cjk(s):
    return sum(1 for ch in s if "\u4e00" <= ch <= "\u9fff")


def latin(s):
    return sum(1 for ch in s if ch.isascii() and ch.isalpha())


def main():
    if not os.path.isdir(ROOT):
        print("找不到会话目录：" + ROOT)
        return 2

    files = []
    for dirpath, _d, fs in os.walk(ROOT):
        for f in fs:
            if f.endswith(".jsonl.zstd"):
                files.append(os.path.join(dirpath, f))
    files.sort(key=os.path.getmtime)
    print("会话文件 %d 个" % len(files))

    n_all = n_zh = 0
    with open(OUT, "w", encoding="utf-8") as w:
        for fp in files:
            try:
                text = load(fp)
            except Exception as e:
                print("  跳过 %s：%s" % (os.path.basename(fp), e))
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
                blocks = (o.get("data") or {}).get("message", {}).get("content") or []
                t = "".join(b.get("text") or "" for b in blocks
                            if isinstance(b, dict) and b.get("type") == "reasoning")
                if not t.strip():
                    continue
                n_all += 1
                c, l = cjk(t), latin(t)
                ratio = 0.0 if c + l == 0 else c / (c + l)
                if ratio <= 0.05:      # 纯英文，跳过
                    continue
                w.write(json.dumps({
                    "data": {"message": {"content": [{"type": "reasoning", "text": t}]},
                             "reasoningChars": len(t), "zhRatio": round(ratio, 3)},
                }, ensure_ascii=False) + "\n")
                n_zh += 1

    print("有思考的 assistant/message %d 条，其中中文/混合 %d 条 → %s" % (n_all, n_zh, OUT))
    return 0


if __name__ == "__main__":
    sys.exit(main())