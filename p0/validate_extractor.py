# -*- coding: utf-8 -*-
"""
P0-1 验证器：用**真实 DSH 会话日志**回放验证「思考抽取」逻辑

它复刻探针插件 index.js 里的抽取逻辑，对历史上真实的会话数据跑一遍，回答三件事：
  1. 有多少条 assistant/message 带 reasoning？
  2. 两条独立路径（持久 content 块 / 流式 reasoning-chunks）抽出的文本是否**完全一致**？
  3. 抽出来的东西是不是**真·思考原文**（打印样本人工核对）？

用法: python validate_extractor.py [会话根目录 ...]
"""
import io
import json
import os
import sys
from collections import Counter

import zstandard as zstd

DEFAULT_ROOTS = [
    r"C:\Users\MSI\.dsh\sessions",
]


def load(path):
    raw = open(path, "rb").read()
    dctx = zstd.ZstdDecompressor()
    with io.BytesIO(raw) as bio, dctx.stream_reader(bio, read_across_frames=True) as r:
        return r.read().decode("utf-8", errors="replace")


def find_sessions(roots):
    out = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            for f in files:
                if f.endswith(".jsonl.zstd"):
                    out.append(os.path.join(dirpath, f))
    return sorted(out)


def extract_from_message(data):
    """复刻插件逻辑：返回 (blockText, streamText, tokenCount, dtSum)"""
    content = (data.get("message") or {}).get("content") or []
    block_text = "".join(b.get("text") or "" for b in content if isinstance(b, dict) and b.get("type") == "reasoning")

    recs = [s for s in (data.get("stream") or []) if isinstance(s, dict) and s.get("type") == "reasoning-chunks"]
    stream_text = "".join("".join(r.get("texts") or []) for r in recs)
    tokens = sum(len(r.get("texts") or []) for r in recs)
    dt_sum = sum(sum(r.get("dt") or []) for r in recs)
    return block_text, stream_text, tokens, dt_sum


def main(roots):
    files = find_sessions(roots)
    print(f"发现会话文件 {len(files)} 个\n")

    total_msg = 0
    with_reasoning = 0
    agree = 0
    disagree = 0
    only_one_path = 0
    chars = []
    tokens = []
    dts = []
    samples = []
    normal = []
    errs = 0

    for fp in files:
        try:
            text = load(fp)
        except Exception as e:
            errs += 1
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
            total_msg += 1
            data = o.get("data") or {}
            bt, st, tk, dt = extract_from_message(data)
            if not bt and not st:
                continue
            with_reasoning += 1
            if bt and st:
                if bt == st:
                    agree += 1
                    if len(normal) < 3:
                        normal.append(bt[:300])
                else:
                    disagree += 1
                    if len(samples) < 8:
                        samples.append(("MISMATCH", bt[:200], st[:200]))
            else:
                only_one_path += 1
                if len(samples) < 8:
                    which = "仅持久块" if bt else "仅流式记录"
                    samples.append((which, (bt or st)[:220], ""))
            chars.append(len(bt or st))
            tokens.append(tk)
            dts.append(dt)

    print("===== 统计 =====")
    print(f"  assistant/message 总数        : {total_msg}")
    print(f"  含 reasoning 的数量           : {with_reasoning}")
    print(f"  两路径都有且**完全一致**      : {agree}")
    print(f"  两路径都有但不一致            : {disagree}")
    print(f"  只有其中一条路径有            : {only_one_path}")
    if chars:
        chars_sorted = sorted(chars)
        print(f"\n  思考文本长度: 最小 {min(chars)} / 中位 {chars_sorted[len(chars_sorted)//2]} / 最大 {max(chars)} 字符")
        print(f"  逐 token 数 : 合计 {sum(tokens)}，中位 {sorted(tokens)[len(tokens)//2]}")
        print(f"  思考耗时(dt 之和) 中位: {sorted(dts)[len(dts)//2]} ms")

    print("\n===== 正常样本：真实思考原文（前 300 字符）=====")
    for i, s in enumerate(normal, 1):
        print(f"\n--- 样本 {i} ---")
        print(s.replace("\n", "\n  "))

    print("\n===== 异常样本 =====")
    for tag, a, b in samples:
        print(f"\n[{tag}]")
        print("  持久块:", a)
        if b:
            print("  流式  :", b)

    print("\n===== 判定 =====")
    ok = with_reasoning > 0 and disagree == 0
    if with_reasoning == 0:
        print("  ❌ 未发现任何 reasoning —— 需换更近期/带思考的会话")
    elif not ok:
        print(f"  ⚠️ 能抽到思考，但两路径有 {disagree} 处不一致，抽取逻辑需按路径区分")
    else:
        print(f"  ✅ 抽取成立：{with_reasoning} 条消息均拿到思考原文，且两条独立路径 100% 一致")
    return 0 if ok else 1


if __name__ == "__main__":
    roots = sys.argv[1:] or DEFAULT_ROOTS
    sys.exit(main(roots))
