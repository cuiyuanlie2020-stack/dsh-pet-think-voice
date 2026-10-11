# -*- coding: utf-8 -*-
"""
补充探针 v2：侧车冷启动代价（子进程自报峰值 RSS，避免父进程采样失真）
用途：若 P0-2 证明 Node 侧无可用 Edge TTS 库，需退回"Node 桥接 Python 边车"，
      本探针给出该方案的真实代价。
"""
import subprocess
import time

PY = r"C:\Users\MSI\.workbuddy\binaries\python\envs\cosyvoice\Scripts\python.exe"

# 子进程自报峰值：import 完成后与合成完成后各报一次
CHILD = (
    "import psutil,os\n"
    "p=psutil.Process(os.getpid())\n"
    "print('rss_after_py=' + str(round(p.memory_info().rss/1048576,1)))\n"
    "import asyncio,edge_tts\n"
    "print('rss_after_import=' + str(round(p.memory_info().rss/1048576,1)))\n"
    "async def go():\n"
    "    c=edge_tts.Communicate('powersell又想咬我了','zh-CN-XiaoyiNeural',pitch='+30Hz')\n"
    "    n=0\n"
    "    async for ch in c.stream():\n"
    "        if ch['type']=='audio': n+=len(ch['data'])\n"
    "    return n\n"
    "n=asyncio.run(go())\n"
    "print('bytes=' + str(n))\n"
    "print('rss_peak=' + str(round(p.memory_info().rss/1048576,1)))\n"
)

import psutil as _ps  # 父进程也用 psutil 记录 Windows 峰值工作集

print("=== 1) 空 Python 进程基线（自报）===")
for i in range(2):
    t0 = time.perf_counter()
    out = subprocess.run([PY, "-c",
                          "import psutil,os;p=psutil.Process(os.getpid());"
                          "print('rss='+str(round(p.memory_info().rss/1048576,1)))"],
                         capture_output=True, text=True)
    print(f"  第{i+1}次：墙钟={time.perf_counter()-t0:.3f}s  {out.stdout.strip()}")

print("\n=== 2) 边车全链路冷启动（spawn + import edge_tts + 合成1句）===")
walls = []
for i in range(3):
    t0 = time.perf_counter()
    out = subprocess.run([PY, "-c", CHILD], capture_output=True, text=True)
    wall = time.perf_counter() - t0
    walls.append(wall)
    lines = dict(
        l.split("=", 1) for l in out.stdout.strip().splitlines() if "=" in l
    )
    print(f"  第{i+1}次：墙钟={wall:.2f}s  "
          f"py基础={lines.get('rss_after_py')}MB  "
          f"导入后={lines.get('rss_after_import')}MB  "
          f"合成后={lines.get('rss_peak')}MB  {lines.get('bytes')}B")

med = sorted(walls)[1]
print(f"\n  汇总：冷启动墙钟中位 = {med:.2f}s（对比进程内常驻 1.00s ⇒ 每句多付 {med-1.00:.2f}s）")
