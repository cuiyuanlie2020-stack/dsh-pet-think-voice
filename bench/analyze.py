# -*- coding: utf-8 -*-
"""
分析器：把浏览器上报的 phase 时间轴与系统采样对齐，算 Live2D 的真实增量
用法: python analyze.py <tag>
读: bench/out/<tag>_samples.json + bench/out/<tag>_report.json
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
TAG = sys.argv[1] if len(sys.argv) > 1 else "run"

samples = json.load(open(os.path.join(OUT, f"{TAG}_samples.json")))
rep = json.load(open(os.path.join(OUT, f"{TAG}_report.json"), encoding="utf-8"))

gl = next((r for r in rep if r.get("event") == "gl"), {})
print(f"### {TAG}")
print(f"WebGL 渲染器 = {gl.get('renderer')}")
for r in rep:
    if r.get("event") in ("phaseResult", "model", "error", "done"):
        print("  " + json.dumps(r, ensure_ascii=False))

# 浏览器 wall 是毫秒 → 转秒，与采样对齐
phases = [r for r in rep if r.get("event") == "phase"]
if len(phases) < 2:
    print("phase 事件不足")
    sys.exit(0)
cuts = [p["wall"] / 1000.0 for p in phases]
end = next((r["wall"] / 1000.0 for r in rep if r.get("event") == "done"), samples[-1]["wall"])

print(f"\n时间轴(秒): baseline {cuts[0]:.1f}→{cuts[1]:.1f} | live2d {cuts[1]:.1f}→{end:.1f}")
print(f"采样覆盖:   {samples[0]['wall']:.1f} → {samples[-1]['wall']:.1f}")


def summary(a, b, label):
    w = [s for s in samples if a <= s["wall"] <= b]
    if len(w) < 3:
        print(f"{label}: 采样不足({len(w)}条)")
        return None
    dur = w[-1]["wall"] - w[0]["wall"]
    dcpu = w[-1]["cpu_s"] - w[0]["cpu_s"]
    gu = [s["gpu_u"] for s in w if s["gpu_u"] is not None]
    gm = [s["gpu_m"] for s in w if s["gpu_m"] is not None]
    rss = [s["rss_mb"] for s in w]
    print(
        f"{label}\n"
        f"   时长 {dur:.1f}s | Edge 进程 {w[-1]['procs']} 个\n"
        f"   CPU  {dcpu:.2f}s = {dcpu/dur*100:.1f}% 单核（本机 24 核 → {dcpu/dur*100/24:.2f}% 整机）\n"
        f"   Edge 总 RSS  {rss[0]:.0f} → {rss[-1]:.0f} MB\n"
        f"   GPU 利用率 平均 {sum(gu)/len(gu):.1f}%  峰值 {max(gu)}%\n"
        f"   GPU 显存   平均 {sum(gm)/len(gm):.0f} MB（含桌面/其他占用）"
    )
    return dict(dur=dur, cpu_s=dcpu, cpu_pct=dcpu / dur * 100, rss0=rss[0], rss1=rss[-1],
                gpu_avg=sum(gu) / len(gu), gpu_max=max(gu), gpu_mem=sum(gm) / len(gm))


print("\n===== 分阶段 =====")
a = summary(cuts[0], cuts[1], "[阶段1] 空舞台（仅 PIXI 渲染循环）")
b = summary(cuts[1], end, "[阶段2] + Live2D 模型（含物理/表情/贴图）")
if a and b:
    print("\n===== 增量 = Live2D 模型的实际代价 =====")
    print(f"   GPU 利用率  {b['gpu_avg'] - a['gpu_avg']:+.1f} 个百分点")
    print(f"   GPU 显存    {b['gpu_mem'] - a['gpu_mem']:+.0f} MB")
    print(f"   CPU         {b['cpu_pct'] - a['cpu_pct']:+.1f} 个百分点（单核）")
    print(f"   Edge 总 RSS 终值 {b['rss1']:.0f} MB")
