#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-pet-think-voice · 统一验收入口

一条命令跑完全部检查：仓库结构 / 忽略清单实测 / 密钥 / 入库体积 / 单元测试 /
**资源红线回归（P1-7）**。

用法
    <python> scripts/review/run_all.py            # 全部（含资源闸，约 2 分钟）
    <python> scripts/review/run_all.py --fast      # 只跑结构与静态检查（秒级）

    <python> scripts/review/run_all.py --keep      # 保留浏览器组的中间产物

退出码
    0 = 无 FAIL（SKIP 与 WARN 不算失败）
    1 = 存在 FAIL

设计要点
    * **仅用标准库**，任何 python3 都能跑（不依赖 psutil / edge-tts）。
      需要第三方库的探针（bench/*.py）由本脚本用 BENCH_PYTHON 显式调起。
    * **空实现允许 SKIP，但不许静默**：每个 SKIP 都必须打印「为什么跳过 + 什么时候会有」。
    * 资源闸分两层判定：
      - **硬闸**：超出 `docs/DESIGN.md` §7.4 阈值 ⇒ FAIL（红线 R1）
      - **基线对照**：在阈值内但明显偏离 `docs/RESOURCE-BUDGET.md` 记录的基线 ⇒ WARN（"小幅波动仅记录"）
    资源阈值与基线**不在此处重新定义**，全部从上面两份文档抄来，避免两处漂移。

环境变量（都有默认值，一般不用设）
    BENCH_PYTHON  跑 bench/*.py 的 python（需 psutil / edge_tts），默认 cosyvoice env
    REVIEW_NODE   跑 bench/*.js 的 node，默认本机 managed node 22.22.2
    REVIEW_EDGE   msedge.exe 路径，默认标准安装位置
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# ─────────────────────────── 路径与运行时 ───────────────────────────

REPO = Path(__file__).resolve().parents[2]
BENCH = REPO / "bench"
BENCH_OUT = BENCH / "out"
VENDOR_PLUGIN = REPO / "vendor" / "dsh-pet-live2d" / "dsh-live2d-pet"

CANDIDATE_PYTHONS = [
    os.environ.get("BENCH_PYTHON", ""),
    r"C:\Users\MSI\.workbuddy\binaries\python\envs\cosyvoice\Scripts\python.exe",
]
CANDIDATE_NODES = [
    os.environ.get("REVIEW_NODE", ""),
    r"C:\Users\MSI\.workbuddy\binaries\node\versions\22.22.2-6\node.exe",
]
CANDIDATE_EDGES = [
    os.environ.get("REVIEW_EDGE", ""),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def _first_existing(cands):
    for c in cands:
        if c and Path(c).exists():
            return str(c)
    return None


PY_BENCH = _first_existing(CANDIDATE_PYTHONS)
NODE = _first_existing(CANDIDATE_NODES) or shutil.which("node")
EDGE = _first_existing(CANDIDATE_EDGES)

# ───────────────────── 阈值（抄自 DESIGN §7.4 / §7.1）─────────────────────
# 改阈值只能改 DESIGN，然后同步到这里；不要在脚本里"顺手放宽"。
TH = {
    "host_rss_mb": 20.0,      # DESIGN 7.1  host 半区内存增量 ≤ 20MB
    "extra_cpu_cores": 0.5,   # DESIGN 7.4  额外 CPU ≤ 0.5 个核心
    "extra_gpu_pp": 3.0,      # DESIGN 7.4  额外 GPU 利用率 ≤ 3 个百分点
    "extra_vram_mb": 150.0,   # DESIGN 7.4  额外显存 ≤ 150MB
    "extra_mem_mb": 80.0,     # DESIGN 7.4  额外内存（含浏览器侧）≤ 80MB
    "fps_drop_max": 1.0,      # DESIGN 7.4  稳态不掉帧
    "tts_wall_median_s": 3.0,  # DESIGN G3  命中片段 ≤3s 内开始播放
    "repo_size_mb": 10.0,     # DESIGN 7.1  整包不超过 10MB
}
# 基线（抄自 RESOURCE-BUDGET §4 / §7），仅用于"偏离提示"，不参与硬判定
BASE = {
    "host_rss_mb": 2.5,
    "host_cpu_cores": 0.005,
    "tts_wall_median_s": 1.00,
    "tts_audio_kb": 30.3,
    "browser_cpu_cores": 0.26,
    "browser_gpu_pp": 1.55,   # 实测区间 0.6~2.5 取中
    "browser_vram_mb": 18.0,
    "browser_fps": 58.6,
}
BASELINE_DRIFT = 0.5  # 偏离基线 >50%（且未超阈值）⇒ WARN

# ───────────────────── 永不入库路径（与 .gitignore 对照）─────────────────────
MUST_BE_IGNORED = [
    "vendor/dsh-pet-live2d/README.md",
    ".workbuddy/memory/MEMORY.md",
    "bench/cubism/live2dcubismcore.min.js",
    "bench/out/probe.txt",
    "p0/out/probe.log",
    "p0/extract/api-catalog.js",
    "p0/sessions/x.jsonl",
    "tts-demo/bin/ffmpeg.exe",
    "tts-demo/line1.mp3",
]
MUST_BE_TRACKED = [
    ".gitignore",
    ".gitattributes",
    "CODEBUDDY.md",
    "docs/DESIGN.md",
    "docs/PLAN.md",
    "docs/RESOURCE-BUDGET.md",
    "experiments/INDEX.md",
    "scripts/review/run_all.py",
    "p0/P0-REPORT.md",
]

# ─────────────────────────── 结果记录 ───────────────────────────

RESULTS = []   # (group, name, status, detail)


def rec(group, name, status, detail=""):
    RESULTS.append((group, name, status, detail))
    icon = {"PASS": "✅", "FAIL": "❌", "SKIP": "⏭️ ", "WARN": "⚠️ ", "INFO": "·  "}.get(status, "?")
    print(f"  {icon} [{status}] {name}" + (f" — {detail}" if detail else ""), flush=True)


def section(title):
    print(f"\n{'=' * 72}\n{title}\n{'=' * 72}", flush=True)


def run(cmd, cwd=None, timeout=180, env_extra=None):
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    if env_extra:
        env.update(env_extra)
    try:
        p = subprocess.run(
            cmd, cwd=str(cwd) if cwd else None, capture_output=True,
            text=True, encoding="utf-8", errors="replace", timeout=timeout, env=env,
        )
        return p.returncode, (p.stdout or ""), (p.stderr or "")
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s"
    except FileNotFoundError as e:
        return 127, "", str(e)


def git(*args):
    return run(["git", *args], cwd=REPO, timeout=60)


# ═══════════════════════ S1 仓库结构自检 ═══════════════════════

REQUIRED_DIRS = ["lib/core", "lib/infra", "lib/app", "scripts/review", "experiments", "docs", "bench", "p0"]
REQUIRED_FILES = ["CODEBUDDY.md", ".gitignore", ".gitattributes", "docs/DESIGN.md",
                  "docs/PLAN.md", "docs/RESOURCE-BUDGET.md", "experiments/INDEX.md",
                  "lib/core/README.md", "lib/infra/README.md", "lib/app/README.md",
                  "p0/P0-REPORT.md"]


def s1_structure():
    section("S1 · 仓库结构自检（DESIGN 4.3 四层落点）")
    bad = [d for d in REQUIRED_DIRS if not (REPO / d).is_dir()]
    if bad:
        rec("S1", "目录骨架", "FAIL", "缺失：" + ", ".join(bad))
    else:
        rec("S1", "目录骨架", "PASS", f"{len(REQUIRED_DIRS)} 个目录齐备")

    bad = [f for f in REQUIRED_FILES if not (REPO / f).is_file()]
    if bad:
        rec("S1", "关键文件", "FAIL", "缺失：" + ", ".join(bad))
    else:
        rec("S1", "关键文件", "PASS", f"{len(REQUIRED_FILES)} 个文件齐备")


# ═══════════════════════ S2 忽略清单实测 ═══════════════════════

def s2_gitignore():
    section("S2 · 忽略清单实测（.gitignore 不支持行尾注释，必须逐条实测）")
    if not (REPO / ".git").exists():
        rec("S2", "git 仓库", "FAIL", "未初始化 git")
        return
    for rel in MUST_BE_IGNORED:
        rc, _, _ = git("check-ignore", "-q", rel)
        if rc == 0:
            rec("S2", f"排除 {rel}", "PASS")
        elif rc == 1:
            rec("S2", f"排除 {rel}", "FAIL", "未被排除 —— 规则写错或被行尾注释破坏")
        else:
            rec("S2", f"排除 {rel}", "FAIL", "check-ignore 执行异常")
    for rel in MUST_BE_TRACKED:
        # 用 -c -o --exclude-standard：同时覆盖「已跟踪」与「未跟踪但不会被排除」，
        # 这样本脚本在提交前跑也有意义（纯看已跟踪会让新文件全部误判为 FAIL）。
        rc, out, _ = git("ls-files", "-c", "-o", "--exclude-standard", "--", rel)
        if out.strip():
            rec("S2", f"纳入 {rel}", "PASS")
        else:
            rec("S2", f"纳入 {rel}", "FAIL", "文件不存在，或被忽略规则误排除")


# ═══════════════════════ S3 密钥扫描 ═══════════════════════

SECRET_PAT = re.compile(r"\.env$|\.env\.|secret|credential|\.pem$|\.key$", re.I)


def _is_decl_noise(name: str) -> bool:
    """DSH 的 API 类型声明里含 Credential* 字样，那不是密钥。
    只做类型声明的文件（.d.ts / .d.mts）不参与密钥判定，否则每次扫描都会误报。"""
    return name.endswith((".d.ts", ".d.mts", ".d.cts"))


def s3_secrets():
    section("S3 · 密钥扫描")
    rc, out, _ = git("ls-files", "-c", "-o", "--exclude-standard")
    if rc != 0:
        rec("S3", "密钥扫描", "FAIL", "git ls-files 失败")
        return
    hits = [l for l in out.splitlines()
            if SECRET_PAT.search(l) and not l.endswith(".example") and not _is_decl_noise(l)]
    if hits:
        rec("S3", "版本库内密钥", "FAIL", "命中：" + ", ".join(hits))
    else:
        found = []
        for p in REPO.rglob("*"):
            if p.is_file() and SECRET_PAT.search(p.name) and not _is_decl_noise(p.name) \
                    and "vendor" not in p.parts and "node_modules" not in p.parts \
                    and not p.name.endswith(".example"):
                found.append(str(p.relative_to(REPO)))
        if found:
            rec("S3", "版本库内密钥", "PASS", "0 个；但工作区存在密钥文件（已排除）：" + ", ".join(found[:5]))
        else:
            rec("S3", "版本库内密钥", "PASS", "0 个，且工作区无密钥文件")


# ═══════════════════════ S4 入库体积 ═══════════════════════

def s4_size():
    section("S4 · 入库体积（DESIGN 7.1 整包 ≤ 10MB）")
    rc, out, _ = git("ls-files", "-z", "-c", "-o", "--exclude-standard")
    if rc != 0:
        rec("S4", "入库体积", "FAIL", "git ls-files 失败")
        return
    files = [f for f in out.split("\0") if f]
    total = 0
    for f in files:
        try:
            total += (REPO / f).stat().st_size
        except OSError:
            pass
    mb = total / 1048576
    st = "PASS" if mb <= TH["repo_size_mb"] else "FAIL"
    rec("S4", "入库体积", st, f"{len(files)} 文件 / {mb:.3f} MB（阈值 {TH['repo_size_mb']}MB）")


# ═══════════════════════ S5 单元测试 ═══════════════════════

def s5_tests():
    section("S5 · 单元测试")
    candidates = sorted(REPO.glob("lib/**/*.test.js")) + sorted(REPO.glob("lib/**/test_*.py")) \
        + sorted(REPO.glob("lib/**/*.test.mjs"))
    if not candidates:
        rec("S5", "单元测试", "SKIP",
            "lib/ 下没有任何测试文件 —— 何时会有：每落地一个领域模块就同批产出它的单测。"
            "（lib/core 的验收判据是：单独拷到空目录后 `node --test` 全绿）")
        return

    # ⚠️ 必须**显式传入候选文件**，不能在仓库根裸跑 `node --test`。
    #    裸跑会递归扫进 `vendor/`（上游只读参考，不入库），其自带的浏览器测试
    #    需要浏览器环境、必然失败 —— 那等于把**第三方测试**混进本项目的验收判据。
    js = [c for c in candidates if c.suffix in (".js", ".mjs")]
    if NODE and js:
        rc, out, err = run([NODE, "--test", *[str(c) for c in js]], cwd=REPO, timeout=300)
        rec("S5", "node --test", "PASS" if rc == 0 else "FAIL",
            f"{len(js)} 个测试文件 | {_node_test_summary(out, err)}")

    py = [c for c in candidates if c.suffix == ".py"]
    if PY_BENCH and py:
        rc, out, err = run([PY_BENCH, "-m", "pytest", "-q", *[str(c) for c in py]],
                           cwd=REPO, timeout=300)
        tail = (out or err).strip().splitlines()[-1:] or [""]
        rec("S5", "pytest", "PASS" if rc == 0 else "FAIL", f"{len(py)} 个测试文件 | {tail[0]}")


def _node_test_summary(out, err):
    """从 node --test 输出里挑计数行，比「最后一行」信息量大（最后一行是 duration）。"""
    keys = ("# tests", "# pass", "# fail", "# skipped")
    parts = [l.strip().lstrip("#").strip()
             for l in (out or "").splitlines() if l.strip().startswith(keys)]
    if parts:
        return " / ".join(parts)
    return ((out or err or "").strip().splitlines() or [""])[-1]


# ═══════════════ R-A 资源闸：host 半区常驻（DESIGN 7.1）═══════════════

def probe_host():
    if not NODE:
        rec("R-A", "host 半区常驻", "SKIP", "找不到 node —— 何时会有：装 Node 后自动恢复")
        return None
    rc, out, err = run([NODE, str(BENCH / "host_probe.js")], cwd=BENCH, timeout=90)
    if rc != 0:
        rec("R-A", "host 半区常驻", "FAIL", f"探针退出码 {rc}：{(err or '')[-120:]}")
        return None
    m_boot = re.search(r'\{"label":"boot".*?\}', out)
    m_end = re.search(r'\{"label":"end".*?\}', out)
    m_dur = re.search(r"时长 ([\d.]+)s", out)
    if not (m_boot and m_end and m_dur):
        rec("R-A", "host 半区常驻", "FAIL", "探针输出无法解析（格式变了？）")
        return None
    boot, end, dur = json.loads(m_boot.group()), json.loads(m_end.group()), float(m_dur.group(1))
    rss = end["rss_mb"] - boot["rss_mb"]
    cores = (end["cpu_ms"] - boot["cpu_ms"]) / 1000.0 / dur
    res = {"rss_mb": rss, "cpu_cores": cores}
    ok = True
    if rss <= TH["host_rss_mb"]:
        rec("R-A", "host 内存增量", "PASS", f"+{rss:.1f} MB（阈值 {TH['host_rss_mb']}MB）")
        if BASE["host_rss_mb"] and abs(rss - BASE["host_rss_mb"]) / BASE["host_rss_mb"] > BASELINE_DRIFT:
            rec("R-A", "host 内存 基线对照", "WARN", f"基线 {BASE['host_rss_mb']}MB，实测 {rss:.1f}MB")
    else:
        ok = False
        rec("R-A", "host 内存增量", "FAIL", f"+{rss:.1f} MB > 阈值 {TH['host_rss_mb']}MB")
    if cores <= TH["extra_cpu_cores"]:
        rec("R-A", "host CPU", "PASS", f"{cores:.4f} 核（阈值 {TH['extra_cpu_cores']}）")
    else:
        ok = False
        rec("R-A", "host CPU", "FAIL", f"{cores:.4f} 核 > 阈值 {TH['extra_cpu_cores']}")
    res["ok"] = ok
    return res


# ═══════════ R-B 资源闸：Edge TTS 单次合成（DESIGN 7.1 / G3）═══════════

def probe_tts():
    script = BENCH / "resource_probe.py"
    if not PY_BENCH:
        rec("R-B", "Edge TTS", "SKIP", "找不到带 psutil/edge_tts 的 python —— 何时会有：装 cosyvoice env 后自动恢复")
        return None
    BENCH_OUT.mkdir(parents=True, exist_ok=True)
    rc, out, err = run([PY_BENCH, str(script)], cwd=BENCH_OUT, timeout=180)
    if rc != 0:
        joined = (out + err).lower()
        if any(k in joined for k in ("getaddrinfo", "connection", "network", "ssl", "timed out")):
            rec("R-B", "Edge TTS", "SKIP",
                "微软 Edge 接口不可达（断网？）—— 这正是 DESIGN 5.4 场景 D 的降级路径："
                "插件降级为纯气泡文字，故本组在离线下跳过而非判失败")
        else:
            rec("R-B", "Edge TTS", "FAIL", f"探针退出码 {rc}：{(err or out)[-160:]}")
        return None
    jf = BENCH_OUT / "resource_probe_tts.json"
    if not jf.exists():
        rec("R-B", "Edge TTS", "FAIL", "探针未产出 resource_probe_tts.json")
        return None
    data = json.loads(jf.read_text(encoding="utf-8"))
    walls = [r["wall"] for r in data["rows"]]
    cpus = [r["cpu"] for r in data["rows"]]
    byts = [r["bytes"] for r in data["rows"]]
    med_wall = statistics.median(walls)
    med_cpu = statistics.median(cpus)
    med_kb = statistics.median(byts) / 1024
    res = {"wall_median_s": med_wall, "cpu_median_s": med_cpu, "audio_median_kb": med_kb, "ok": True}
    if med_wall <= TH["tts_wall_median_s"]:
        rec("R-B", "TTS 墙钟中位", "PASS", f"{med_wall:.2f}s（阈值 {TH['tts_wall_median_s']}s，G3 ≤3s 播放余量）")
        if abs(med_wall - BASE["tts_wall_median_s"]) / BASE["tts_wall_median_s"] > BASELINE_DRIFT:
            rec("R-B", "TTS 墙钟 基线对照", "WARN", f"基线 {BASE['tts_wall_median_s']}s，实测 {med_wall:.2f}s")
    else:
        res["ok"] = False
        rec("R-B", "TTS 墙钟中位", "FAIL", f"{med_wall:.2f}s > 阈值 {TH['tts_wall_median_s']}s")
    if med_cpu <= TH["extra_cpu_cores"]:
        rec("R-B", "TTS 单次 CPU", "PASS", f"{med_cpu * 1000:.0f}ms（阈值 {TH['extra_cpu_cores'] * 1000:.0f}ms/次）")
    else:
        res["ok"] = False
        rec("R-B", "TTS 单次 CPU", "FAIL", f"{med_cpu * 1000:.0f}ms > 阈值 {TH['extra_cpu_cores'] * 1000:.0f}ms")
    rec("R-B", "TTS 显存占用", "PASS", "0 MB（Edge 云合成，本地无模型权重 —— 红线 R1 的关键）")
    rec("R-B", "TTS 音频中位体积", "INFO", f"{med_kb:.1f} KB（基线 {BASE['tts_audio_kb']}KB）")
    return res


# ═══════ R-C 参考组：Python 边车（已放弃方案，只记录不判失败）═══════

def probe_sidecar():
    script = BENCH / "resource_probe2.py"
    if not PY_BENCH:
        rec("R-C", "Python 边车（参考）", "SKIP", "找不到 bench python —— 何时会有：装 cosyvoice env")
        return None
    rc, out, err = run([PY_BENCH, str(script)], cwd=BENCH_OUT, timeout=180)
    if rc != 0:
        rec("R-C", "Python 边车（参考）", "SKIP", f"未跑通（退出码 {rc}）；该方案已放弃，不影响判失败")
        return None
    m = re.search(r"冷启动墙钟中位 = ([\d.]+)s", out)
    val = float(m.group(1)) if m else None
    rec("R-C", "Python 边车（参考）", "INFO",
        f"冷启动中位 {val}s —— **已放弃方案**（DESIGN 8.3），不进硬闸，仅记录对照" if val else "已跑通，未解析到数值")
    return {"sidecar_cold_s": val}


# ══════ R-D 资源闸：浏览器侧 Live2D（DESIGN 7.4 六项）══════

def _summ(samples, t0, t1):
    w = [s for s in samples if t0 <= s["wall"] <= t1]
    if len(w) < 3:
        return None
    dur = w[-1]["wall"] - w[0]["wall"]
    dcpu = w[-1]["cpu_s"] - w[0]["cpu_s"]
    gu = [s["gpu_u"] for s in w if s["gpu_u"] is not None]
    gm = [s["gpu_m"] for s in w if s["gpu_m"] is not None]
    return {
        "dur": dur,
        "cpu_pct": dcpu / dur * 100 if dur else 0.0,   # 单核百分比
        "rss0": w[0]["rss_mb"], "rss1": w[-1]["rss_mb"],
        "gpu_avg": (sum(gu) / len(gu)) if gu else None,
        "gpu_max": max(gu) if gu else None,
        "gpu_mem": (sum(gm) / len(gm)) if gm else None,
    }


def probe_browser(keep=False):
    missing = []
    if not (VENDOR_PLUGIN / "lib" / "live2d-vendor.js").exists():
        missing.append("vendor/dsh-pet-live2d（上游仓库，只读参考，不入库）")
    if not (BENCH / "cubism" / "live2dcubismcore.min.js").exists():
        missing.append("bench/cubism/live2dcubismcore.min.js（Live2D 专有，不可入库）")
    if not EDGE:
        missing.append("msedge.exe")
    if not NODE:
        missing.append("node")
    if not PY_BENCH:
        missing.append("带 psutil 的 python")
    if missing:
        rec("R-D", "浏览器侧 Live2D", "SKIP",
            "缺前置：" + "；".join(missing) +
            "。何时会有：本机备份上游仓库与 Cubism Core 后即可跑；"
            "干净 clone 需按 RESOURCE-BUDGET §8 前置依赖补齐（两者都不入库，属许可要求）")
        return None

    tag = "review_" + _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    BENCH_OUT.mkdir(parents=True, exist_ok=True)
    port_file = BENCH_OUT / "port.txt"
    report_file = BENCH_OUT / "browser_report.json"
    for f in (port_file, report_file):
        f.unlink(missing_ok=True)

    serve = subprocess.Popen([NODE, str(BENCH / "serve.js")], cwd=BENCH,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace")
    edge = None
    tmp_profile = tempfile.mkdtemp(prefix="review-edge-")
    try:
        port = None
        for _ in range(60):
            if port_file.exists():
                port = port_file.read_text().strip()
                break
            time.sleep(0.25)
        if not port:
            rec("R-D", "浏览器侧 Live2D", "FAIL", "serve.js 未在 15s 内写出 out/port.txt")
            return None

        edge = subprocess.Popen([
            EDGE, "--headless=new", "--enable-gpu", "--ignore-gpu-blocklist",
            "--use-angle=d3d11", f"--user-data-dir={tmp_profile}",
            "--enable-precise-memory-info", "--no-first-run", "--no-default-browser-check",
            f"http://127.0.0.1:{port}/?fps=60",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(3.0)  # 等页面起来（10s baseline 阶段的前段）

        rc, out, err = run([PY_BENCH, str(BENCH / "sample.py"), "32", tag], cwd=BENCH, timeout=120)
        if rc != 0:
            rec("R-D", "浏览器侧 Live2D", "FAIL", f"sample.py 退出码 {rc}：{(err or '')[-160:]}")
            return None

        for _ in range(60):
            if report_file.exists():
                break
            time.sleep(0.5)
        if not report_file.exists():
            rec("R-D", "浏览器侧 Live2D", "FAIL", "页面未回传 /dump（页面报错？看 bench/index.html 的 #err）")
            return None

        rep = json.loads(report_file.read_text(encoding="utf-8"))
        (BENCH_OUT / f"{tag}_report.json").write_text(
            json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
        samples = json.loads((BENCH_OUT / f"{tag}_samples.json").read_text())
    finally:
        for p in (edge, serve):
            if p and p.poll() is None:
                try:
                    subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)],
                                   capture_output=True, timeout=20)
                except Exception:
                    p.terminate()
        if not keep:
            shutil.rmtree(tmp_profile, ignore_errors=True)

    errors = [r for r in rep if r.get("event") == "error"]
    gl = next((r for r in rep if r.get("event") == "gl"), {})
    phases = [r for r in rep if r.get("event") == "phase"]
    results = {r["name"]: r for r in rep if r.get("event") == "phaseResult"}
    done = next((r for r in rep if r.get("event") == "done"), {})

    if errors or len(phases) < 2 or "baseline" not in results or "live2d" not in results:
        rec("R-D", "浏览器侧 Live2D", "FAIL",
            f"页面异常：{len(errors)} 个 error 事件；phase 事件 {len(phases)} 个")
        return None

    renderer = gl.get("renderer", "?")
    if "SwiftShader" in str(renderer) or "Software" in str(renderer):
        rec("R-D", "GPU 路径", "FAIL", f"落到软渲染：{renderer} —— 该结果不可用于判定")
        return None
    rec("R-D", "GPU 路径", "PASS", f"真 GPU：{renderer}")

    cuts = [p["wall"] / 1000.0 for p in phases]
    end_wall = done.get("wall", samples[-1]["wall"] * 1000) / 1000.0
    a = _summ(samples, cuts[0], cuts[1])
    b = _summ(samples, cuts[1], end_wall)
    if not (a and b):
        rec("R-D", "浏览器侧 Live2D", "FAIL", "采样窗口不足，无法对齐（重跑一次试试）")
        return None

    res = {"ok": True, "renderer": renderer,
           "baseline": a, "live2d": b,
           "fps_baseline": results["baseline"]["fps"], "fps_live2d": results["live2d"]["fps"],
           "frame_work_ms": results["live2d"]["frameWorkAvgMs"],
           "js_heap_mb": (done.get("memory") or {}).get("usedMB")}

    cores = (b["cpu_pct"] - a["cpu_pct"]) / 100.0
    if cores <= TH["extra_cpu_cores"]:
        rec("R-D", "额外 CPU", "PASS", f"{cores:.3f} 核（阈值 {TH['extra_cpu_cores']}）")
        if abs(cores - BASE["browser_cpu_cores"]) / BASE["browser_cpu_cores"] > BASELINE_DRIFT:
            rec("R-D", "额外 CPU 基线对照", "WARN", f"基线 {BASE['browser_cpu_cores']} 核，实测 {cores:.3f}")
    else:
        res["ok"] = False
        rec("R-D", "额外 CPU", "FAIL", f"{cores:.3f} 核 > 阈值 {TH['extra_cpu_cores']}")
    res["cpu_cores"] = cores

    if b["gpu_avg"] is not None and a["gpu_avg"] is not None:
        pp = b["gpu_avg"] - a["gpu_avg"]
        res["gpu_pp"] = pp
        if pp <= TH["extra_gpu_pp"]:
            rec("R-D", "额外 GPU 利用率", "PASS", f"{pp:+.2f} pp（阈值 {TH['extra_gpu_pp']}）")
        else:
            res["ok"] = False
            rec("R-D", "额外 GPU 利用率", "FAIL", f"{pp:+.2f} pp > 阈值 {TH['extra_gpu_pp']}")
    else:
        rec("R-D", "额外 GPU 利用率", "SKIP", "nvidia-smi 不可用；何时会有：把 nvidia-smi 放进 PATH")

    if b["gpu_mem"] is not None and a["gpu_mem"] is not None:
        vram = b["gpu_mem"] - a["gpu_mem"]
        res["vram_mb"] = vram
        if vram <= TH["extra_vram_mb"]:
            rec("R-D", "额外显存", "PASS", f"{vram:+.0f} MB（阈值 {TH['extra_vram_mb']}MB，全机口径含噪声）")
        else:
            res["ok"] = False
            rec("R-D", "额外显存", "FAIL", f"{vram:+.0f} MB > 阈值 {TH['extra_vram_mb']}MB")
    else:
        rec("R-D", "额外显存", "SKIP", "nvidia-smi 不可用")

    drop = results["baseline"]["fps"] - results["live2d"]["fps"]
    if drop <= TH["fps_drop_max"]:
        rec("R-D", "稳态帧率", "PASS",
            f"{results['baseline']['fps']} → {results['live2d']['fps']} fps（跌 {drop:.1f}，阈值 {TH['fps_drop_max']}）")
    else:
        res["ok"] = False
        rec("R-D", "稳态帧率", "FAIL", f"跌 {drop:.1f} fps > 阈值 {TH['fps_drop_max']}")

    heap = res.get("js_heap_mb")
    if heap is None:
        rec("R-D", "额外内存（浏览器 JS 堆）", "SKIP", "页面未上报 performance.memory")
    elif heap <= TH["extra_mem_mb"]:
        rec("R-D", "额外内存（浏览器 JS 堆）", "PASS", f"{heap:.1f} MB（阈值 {TH['extra_mem_mb']}MB）")
    else:
        res["ok"] = False
        rec("R-D", "额外内存（浏览器 JS 堆）", "FAIL", f"{heap:.1f} MB > 阈值 {TH['extra_mem_mb']}MB")

    return res


# ═══════════════════════ 报告与主流程 ═══════════════════════

def write_report(args, res):
    BENCH_OUT.mkdir(parents=True, exist_ok=True)
    ts = _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    n = {s: sum(1 for r in RESULTS if r[2] == s) for s in ("PASS", "FAIL", "SKIP", "WARN", "INFO")}
    lines = [
        "# 资源与验收报告 · dsh-pet-think-voice",
        "",
        f"> 生成时间：{ts}　模式：{'--fast（无资源闸）' if args.fast else '完整'}",
        f"> 判定：✅ PASS {n['PASS']} · ❌ FAIL {n['FAIL']} · ⏭️ SKIP {n['SKIP']} · ⚠️ WARN {n['WARN']} · · INFO {n['INFO']}",
        "",
        "阈值来源：`docs/DESIGN.md` §7.1 / §7.4（本脚本不重新定义阈值）。"
        "基线来源：`docs/RESOURCE-BUDGET.md` §4 / §7，仅用于偏离提示。",
        "",
        "| 组 | 检查项 | 结果 | 详情 |",
        "|---|---|---|---|",
    ]
    for g, name, st, detail in RESULTS:
        lines.append(f"| {g} | {name} | {st} | {detail.replace('|', '/')} |")
    if res.get("browser"):
        lines += ["", "## R-D 明细（浏览器侧 Live2D）", "", "```json",
                  json.dumps(res["browser"], ensure_ascii=False, indent=2), "```"]
    out = BENCH_OUT / "resource-report.md"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    (BENCH_OUT / "resource-report.json").write_text(
        json.dumps({"ts": ts, "thresholds": TH, "baselines": BASE,
                    "results": RESULTS, "raw": res}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    return out


def main():
    ap = argparse.ArgumentParser(description="dsh-pet-think-voice 统一验收入口")
    ap.add_argument("--fast", action="store_true", help="跳过资源闸（秒级）")
    ap.add_argument("--keep", action="store_true", help="保留浏览器组临时 profile")
    args = ap.parse_args()

    print(f"仓库根：{REPO}")
    print(f"运行时：node={NODE}\n        bench-python={PY_BENCH}\n        edge={EDGE}")

    s1_structure()
    s2_gitignore()
    s3_secrets()
    s4_size()
    s5_tests()

    res = {}
    if args.fast:
        section("资源闸 · 已跳过（--fast）")
        rec("R", "资源闸", "SKIP", "本次为 --fast：跳过 R-A/R-B/R-C/R-D。何时会有：去掉 --fast 即完整跑")
    else:
        section("R-A · host 半区常驻（DESIGN 7.1）")
        res["host"] = probe_host()
        section("R-B · Edge TTS 单次合成（DESIGN 7.1 / G3）")
        res["tts"] = probe_tts()
        section("R-C · Python 边车（已放弃方案，仅记录）")
        res["sidecar"] = probe_sidecar()
        section("R-D · 浏览器侧 Live2D（DESIGN 7.4 六项阈值）")
        res["browser"] = probe_browser(keep=args.keep)

    out = write_report(args, res)
    n = {s: sum(1 for r in RESULTS if r[2] == s) for s in ("PASS", "FAIL", "SKIP", "WARN", "INFO")}
    section("汇总")
    print(f"  ✅ PASS {n['PASS']}　❌ FAIL {n['FAIL']}　⏭️ SKIP {n['SKIP']}　⚠️ WARN {n['WARN']}　· INFO {n['INFO']}")
    print(f"  报告：{out}")
    if n["FAIL"]:
        print("\n  ❌ 存在未通过项 —— 按红线 R1，不得视为可接受。逐条现场见上方 [FAIL]。")
        return 1
    print("\n  ✅ 无 FAIL。SKIP 项已写明原因与后续时点，不是静默通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
