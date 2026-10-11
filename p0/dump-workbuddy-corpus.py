# -*- coding: utf-8 -*-
"""导出 **WorkBuddy 本地对话库**里的中文思考 —— P4-1 语料的第二个（更大的）来源。

⚠️ 为什么需要第二来源：P4-1 初版只用了 `~/.dsh/sessions` 的 236 条思考
（中文主导仅 38 条），样本太小 —— "吐槽桶天然稀薄"这类结论很可能是**采样偏差**。
WorkBuddy 库里有 24852 条 reasoning，其中中文主导 **10932 条（44%）**，
正好是"中文思考"的天然大样本（WorkBuddy 带中文身份文件 SOUL/USER.md，模型自然用中文想）。

输出格式与 `corpus-zh.jsonl` / `corpus.jsonl` **保持一致**（同样包一层
`{"data":{"message":{"content":[{"type":"reasoning","text":...}]}}}`），
这样 `p0/zh-calibrate.mjs` / `zh-marker-probe*.mjs` 可以直接吃，不需要改。

用法：
    <bench-py> p0/dump-workbuddy-corpus.py [zh|all]     # 默认 zh（中文/混合）
    <node>     p0/zh-calibrate.mjs p0/out/corpus-wb-zh.jsonl
    <node>     p0/zh-marker-probe.mjs p0/out/corpus-wb-zh.jsonl

隐私（红线 R2）：只导出 reasoning 块；正文 / 工具产出 / 用户输入一律丢弃。
产物落 `p0/out/`（已 gitignore，**永不入库**）。
"""
import glob
import json
import os
import sys

ROOT = r"C:\Users\MSI\.workbuddy\projects"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")


def cjk(s):
    return sum(1 for ch in s if "\u4e00" <= ch <= "\u9fff")


def latin(s):
    return sum(1 for ch in s if ch.isascii() and ch.isalpha())


def ratio(s):
    c, l = cjk(s), latin(s)
    return 0.0 if c + l == 0 else c / (c + l)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "zh"
    out = os.path.join(OUT_DIR, "corpus-wb-%s.jsonl" % mode)
    min_ratio = 0.05 if mode == "zh" else -1.0

    files = [f for f in glob.glob(os.path.join(ROOT, "*", "*.jsonl"))
             if "file-rollback" not in f]
    files.sort()
    print("会话文件 %d 个" % len(files))

    seen = set()
    n_all = n_out = 0
    with open(out, "w", encoding="utf-8") as w:
        for fp in files:
            try:
                fh = open(fp, encoding="utf-8", errors="replace")
            except Exception as e:
                print("  跳过 %s：%s" % (os.path.basename(fp), e))
                continue
            with fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        o = json.loads(line)
                    except Exception:
                        continue
                    if o.get("type") != "reasoning":
                        continue
                    rc = o.get("rawContent")
                    if not isinstance(rc, list):
                        continue
                    text = "".join(
                        b.get("text") or "" for b in rc
                        if isinstance(b, dict) and b.get("type") == "reasoning_text"
                    )
                    if not text.strip():
                        continue
                    n_all += 1
                    # 同一条 reasoning 会因 provider 重试而重复出现，按内容去重
                    key = hash(text[:400] + text[-200:])
                    if key in seen:
                        continue
                    seen.add(key)
                    r = ratio(text)
                    if r <= min_ratio:
                        continue
                    w.write(json.dumps({
                        "data": {"message": {"content": [{"type": "reasoning", "text": text}]},
                                 "reasoningChars": len(text), "zhRatio": round(r, 3)},
                    }, ensure_ascii=False) + "\n")
                    n_out += 1

    print("reasoning 原始 %d 条，去重后导出 %d 条 → %s" % (n_all, n_out, out))
    return 0


if __name__ == "__main__":
    sys.exit(main())