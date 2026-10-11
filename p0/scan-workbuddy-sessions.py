# -*- coding: utf-8 -*-
"""扫描 **WorkBuddy 本地对话库**里的 reasoning —— 比 DSH 会话大两个数量级的语料源。

为什么需要：P4-1 的中文重校只用了 `~/.dsh/sessions` 的 **236 条**思考（中文仅 38 条），
样本太小 —— 「吐槽桶天然稀薄」这个结论很可能是**采样偏差**，不是模型行为。
WorkBuddy 库里有 **24878 条 reasoning**（`~/.workbuddy/projects/*/*.jsonl`，明文，非 zstd）。

本脚本**只输出统计量**（条数、语种占比、长度分位、思考语种与 provider 的关系），
不打印任何思考原文。原文导出见 `dump-workbuddy-corpus.py`（同样不入库）。

用法：
    <bench-py> p0/scan-workbuddy-sessions.py
"""
import glob
import json
import os
import sys

ROOT = r"C:\Users\MSI\.workbuddy\projects"


def cjk(s):
    return sum(1 for ch in s if "\u4e00" <= ch <= "\u9fff")


def latin(s):
    return sum(1 for ch in s if ch.isascii() and ch.isalpha())


def ratio(s):
    c, l = cjk(s), latin(s)
    return 0.0 if c + l == 0 else c / (c + l)


def iter_reasoning(path):
    """产出 (文本, provider, 时间戳)。"""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
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
                if text.strip() == "":
                    continue
                pd = o.get("providerData") or {}
                provider = pd.get("model") or pd.get("provider") or pd.get("id") or "?"
                yield text, str(provider), o.get("timestamp") or 0
    except Exception as e:
        print("  跳过 %s：%s" % (os.path.basename(path), e))


def pct(xs, p):
    if not xs:
        return 0
    s = sorted(xs)
    return s[min(len(s) - 1, round(p / 100 * (len(s) - 1)))]


def main():
    files = [f for f in glob.glob(os.path.join(ROOT, "*", "*.jsonl"))
             if "file-rollback" not in f]
    print("会话文件 %d 个，共 %.1f MB" % (len(files), sum(os.path.getsize(f) for f in files) / 1e6))

    all_zh, all_len, providers = [], [], {}
    n_total = 0
    n_zh = n_mix = n_en = 0

    for fp in sorted(files):
        for text, provider, _ts in iter_reasoning(fp):
            n_total += 1
            all_len.append(len(text))
            providers[provider] = providers.get(provider, 0) + 1
            r = ratio(text)
            all_zh.append(r)
            if r > 0.3:
                n_zh += 1
            elif r > 0.05:
                n_mix += 1
            else:
                n_en += 1

    print("\n=== reasoning 总量 ===")
    print("  %d 条（DSH 那边只有 236 条）" % n_total)
    print("  中文主导(>0.3)  %5d (%4.1f%%)" % (n_zh, 100.0 * n_zh / max(1, n_total)))
    print("  混合(0.05~0.3)  %5d (%4.1f%%)" % (n_mix, 100.0 * n_mix / max(1, n_total)))
    print("  英文主导(<0.05) %5d (%4.1f%%)" % (n_en, 100.0 * n_en / max(1, n_total)))
    print("  平均中文占比 %.3f" % (sum(all_zh) / max(1, len(all_zh))))
    print("\n=== 长度 ===")
    print("  p25=%d  中位=%d  p75=%d  p95=%d  max=%d  总字数=%d"
          % (pct(all_len, 25), pct(all_len, 50), pct(all_len, 75),
             pct(all_len, 95), max(all_len or [0]), sum(all_len)))

    print("\n=== provider 分布（Top 12）===")
    for k, v in sorted(providers.items(), key=lambda x: -x[1])[:12]:
        print("  %-42s %d" % (k[:42], v))
    return 0


if __name__ == "__main__":
    sys.exit(main())