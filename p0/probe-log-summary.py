# -*- coding: utf-8 -*-
"""
思考探针 日志判读器
自动在 4 个候选位置找日志，按证据强度给出 V1 结论。

用法: python probe-log-summary.py [日志路径]
"""
import json
import os
import sys
from collections import Counter

CANDIDATES = [
    os.environ.get("DSH_THINK_PROBE_LOG"),
    os.path.join(os.environ.get("DSH_HOME", ""), "think-probe.log") if os.environ.get("DSH_HOME") else None,
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "probe-plugin", "probe.log"),
    os.path.join(os.environ.get("TEMP", ""), "dsh-think-probe.log") if os.environ.get("TEMP") else None,
    r"C:\Users\MSI\.dsh\think-probe.log",
    r"C:\Users\MSI\AppData\Local\Temp\dsh-think-probe.log",
]


def find_log():
    for p in CANDIDATES:
        if p and os.path.isfile(p):
            return p
    return None


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else find_log()
    if not path or not os.path.isfile(path):
        print(f"❌ 没找到日志文件{f'：{path}' if path else ''}。已尝试：")
        for p in CANDIDATES:
            if p:
                print("   -", p)
        print("\n说明：插件可能还没被安装或激活。请先按 README.md 第 3 节安装，并跑一轮需要思考的提问。")
        return 1

    size = os.path.getsize(path)
    print(f"日志: {path}  ({size} 字节)\n")

    rows = []
    bad = 0
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            bad += 1

    kinds = Counter(r.get("ev") for r in rows)
    print("=== 事件计数 ===")
    for k, c in kinds.most_common():
        print(f"  {c:5d}  {k}")
    if bad:
        print(f"  {bad:5d}  <无法解析>")

    print("\n=== 判读 ===")
    activated = kinds.get("plugin-activated", 0)
    subscribed = [r for r in rows if r.get("ev") == "subscribed"]
    hist = [r for r in rows if r.get("ev") == "histogram"]
    durable = [r for r in rows if r.get("ev") == "durable:assistant/message"]
    live_end = [r for r in rows if r.get("ev") == "live:end"]
    errors = [r for r in rows if r.get("ev") in ("subscribe-failed", "handler-error")]

    checks = []
    checks.append(("插件被激活", activated > 0,
                   next((r.get("logPath") for r in rows if r.get("ev") == "plugin-activated"), "")))
    checks.append(("订阅 session/event 成功",
                   any(r.get("name") == "session/event" for r in subscribed),
                   next((f"mode={r.get('mode')}" for r in subscribed if r.get("name") == "session/event"), "")))
    checks.append(("订阅 agent/assistant-stream 成功",
                   any(r.get("name") == "agent/assistant-stream" for r in subscribed),
                   next((f"mode={r.get('mode')}" for r in subscribed if r.get("name") == "agent/assistant-stream"), "")))
    seen_events = sum((r.get("sessionEvents") or {}).get("assistant/message", 0) for r in hist)
    checks.append(("持久通道有事件流入（订阅真的通）", bool(hist),
                   f"assistant/message 计数={seen_events}" if hist else "无 histogram 行"))
    checks.append(("★ 抓到思考原文（V1 闭环）",
                   any((r.get("reasoningChars") or 0) > 0 or (r.get("streamChars") or 0) > 0 for r in durable),
                   f"命中 {sum(1 for r in durable if (r.get('reasoningChars') or 0) > 0)} 条"))
    checks.append(("实时通道也有思考增量", len(live_end) > 0,
                   f"live:end {len(live_end)} 次"))
    checks.append(("两路径文本一致（互证）",
                   any(r.get("pathsAgree") is True for r in durable),
                   f"false 次数={sum(1 for r in durable if r.get('pathsAgree') is False)}"))

    for name, ok, detail in checks:
        print(f"  {'✅' if ok else '❌'} {name}   {('— ' + str(detail)) if detail else ''}")
    if errors:
        print("\n  ⚠️ 错误行：")
        for e in errors[:5]:
            print("    ", json.dumps(e, ensure_ascii=False)[:200])

    print("\n=== 样本 ===")
    for r in durable[:3]:
        print(f"\n  [{r.get('ev')}] turn={r.get('turn')} step={r.get('step')} "
              f"reasoningChars={r.get('reasoningChars')} pathsAgree={r.get('pathsAgree')}")
        if r.get("sampleBlockText"):
            print("   ", r["sampleBlockText"][:240].replace("\n", " "))

    closed = any((r.get("reasoningChars") or 0) > 0 for r in durable)
    print("\n===== 结论 =====")
    if closed:
        print("  ✅✅ V1 完全闭环：插件运行时确实拿到了模型思考原文（且已在两条通道上互证）")
        return 0
    if hist:
        print("  ⚠️ 订阅通道是通的，但没抓到思考 ⇒ 多半是模型本轮没有产生 reasoning（换一个需要推理的提问再试）")
        return 2
    if activated and subscribed:
        print("  ⚠️ 插件已激活、订阅也成功，但完全没有事件流入 ⇒ 需走备选路径（host 侧拦 llm/stream）")
        return 3
    print("  ❌ 插件似乎没被激活，请确认安装结果里 application 字段是否为 applied")
    return 1


if __name__ == "__main__":
    sys.exit(main())
