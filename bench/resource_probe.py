# -*- coding: utf-8 -*-
"""
Edge TTS 运行时资源画像探针（本项目专用）
测量：单次合成的墙钟耗时 / CPU 时间 / 音频字节 / 进程 RSS 峰值
配置：DESIGN 6.3 定稿参数 voice=zh-CN-XiaoyiNeural, pitch=+30Hz
"""
import asyncio
import json
import statistics
import time

import edge_tts
import psutil

VOICE = "zh-CN-XiaoyiNeural"
PITCH = "+30Hz"

# 真实场景台词（中英混读，2 短 + 3 中长 + 1 长）
SAMPLES = [
    "powersell又想咬我了",
    "哦——原来 param 是必填的，难怪一直报 undefined。",
    "等等，这个正则怎么写都不对，我是不是把方向搞反了？",
    "嗯……这个 bug 藏得真深，我绕了一大圈才找到。",
    "好，思路清晰了，let me 把这个 function 重写一下。",
    "等等，这个正则怎么写都不对，我是不是把方向搞反了？哦，原来 param 是必填的，"
    "难怪一直报 undefined。powersell 又想咬我了，这已经是第三次了。嗯，这个 bug 藏得真深，"
    "我绕了一大圈才找到。好，思路清晰了，let me 把这个 function 重写一下。",
]


def rss_mb(proc):
    return proc.memory_info().rss / 1024 / 1024


async def synth_once(text):
    """返回音频总字节数"""
    comm = edge_tts.Communicate(text, VOICE, pitch=PITCH)
    n = 0
    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            n += len(chunk["data"])
    return n


async def main():
    proc = psutil.Process()
    base_rss = rss_mb(proc)
    print(f"[基线] 导入 edge_tts 后进程 RSS = {base_rss:.1f} MB")

    rows = []
    for i, text in enumerate(SAMPLES):
        cpu0 = proc.cpu_times()
        t0 = time.perf_counter()
        nbytes = await synth_once(text)
        wall = time.perf_counter() - t0
        cpu1 = proc.cpu_times()
        cpu = (cpu1.user - cpu0.user) + (cpu1.system - cpu0.system)
        rss = rss_mb(proc)
        rows.append(
            dict(
                idx=i + 1,
                chars=len(text),
                wall=wall,
                cpu=cpu,
                bytes=nbytes,
                rss=rss,
                cold=(i == 0),
            )
        )
        tag = "冷启动" if i == 0 else "热"
        print(
            f"[{tag}] #{i + 1} 字数={len(text):3d} 墙钟={wall:5.2f}s "
            f"CPU={cpu * 1000:6.1f}ms 音频={nbytes / 1024:6.1f}KB 进程RSS={rss:.1f}MB"
        )

    walls = [r["wall"] for r in rows]
    cpus = [r["cpu"] for r in rows]
    byts = [r["bytes"] for r in rows]
    print("\n===== 汇总 =====")
    print(f"墙钟   最小={min(walls):.2f}s  中位={statistics.median(walls):.2f}s  最大={max(walls):.2f}s")
    print(f"CPU    最小={min(cpus)*1000:.0f}ms  中位={statistics.median(cpus)*1000:.0f}ms  最大={max(cpus)*1000:.0f}ms")
    print(f"音频   最小={min(byts)/1024:.1f}KB  中位={statistics.median(byts)/1024:.1f}KB  最大={max(byts)/1024:.1f}KB")
    print(f"冷启动(第1次) = {rows[0]['wall']:.2f}s；热态中位 = {statistics.median(walls[1:]):.2f}s")
    print(f"进程 RSS：基线 {base_rss:.1f}MB → 峰值 {max(r['rss'] for r in rows):.1f}MB "
          f"(增量 {max(r['rss'] for r in rows) - base_rss:+.1f}MB)")
    print(f"字符/秒 吞吐 ≈ {statistics.median([r['chars'] / r['wall'] for r in rows]):.1f} 字/秒")
    print(f"KB/秒 下行 ≈ {statistics.median([r['bytes'] / 1024 / r['wall'] for r in rows]):.1f} KB/秒")

    with open("resource_probe_tts.json", "w", encoding="utf-8") as f:
        json.dump(
            dict(voice=VOICE, pitch=PITCH, base_rss_mb=base_rss, rows=rows),
            f,
            ensure_ascii=False,
            indent=2,
        )
    print("\n明细已写入 resource_probe_tts.json")


if __name__ == "__main__":
    asyncio.run(main())
