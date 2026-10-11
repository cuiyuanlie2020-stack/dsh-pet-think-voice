# -*- coding: utf-8 -*-
"""
浏览器侧运行时开销采样器（只负责采样，不做分析）
用法: python sample.py <秒数> <tag>
产物: bench/out/<tag>_samples.json
"""
import json
import os
import subprocess
import sys
import time

import psutil

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)

DUR = float(sys.argv[1]) if len(sys.argv) > 1 else 32.0
TAG = sys.argv[2] if len(sys.argv) > 2 else "run"


def edge_cpu_rss():
    cpu = 0.0
    rss = 0
    n = 0
    for p in psutil.process_iter(["name"]):
        try:
            nm = (p.info.get("name") or "").lower()
            if nm.startswith("msedge"):
                ct = p.cpu_times()
                cpu += ct.user + ct.system
                rss += p.memory_info().rss
                n += 1
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    return cpu, rss / 1048576, n


def gpu():
    try:
        o = subprocess.run(
            ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=6,
        ).stdout.strip()
        u, m = [x.strip() for x in o.split(",")[:2]]
        return int(u), int(m)
    except Exception:
        return None, None


samples = []
t_start = time.time()
cpu0, rss0, n0 = edge_cpu_rss()
gu0, gm0 = gpu()
print(f"[基线·Edge 未启动] 进程数={n0} 累计CPU={cpu0:.2f}s RSS={rss0:.0f}MB GPU={gu0}% 显存={gm0}MB")

while time.time() - t_start < DUR:
    cpu, rss, n = edge_cpu_rss()
    u, m = gpu()
    samples.append(
        dict(t=round(time.time() - t_start, 2), wall=time.time(),
             cpu_s=round(cpu, 3), rss_mb=round(rss, 1), procs=n, gpu_u=u, gpu_m=m)
    )
    time.sleep(0.5)

json.dump(samples, open(os.path.join(OUT, f"{TAG}_samples.json"), "w"), indent=1)
print(f"采样完成：{len(samples)} 条 → out/{TAG}_samples.json")
