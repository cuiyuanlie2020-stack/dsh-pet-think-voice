/**
 * `lib/infra/load-probe.js` — 基础设施层：真实负载采样
 *
 * 两个数据源，都**不引 npm 依赖**（红线 R3）：
 *
 * | 线 | 来源 | 拿不到时 |
 * |---|---|---|
 * | CPU | `os.cpus()` 的 idle/total **差值** | 不会拿不到 |
 * | GPU | `nvidia-smi`（**显卡驱动自带的命令**，不是 npm 包） | 返回 `null`，负载闸退化成"只看 CPU" |
 *
 * ⚠️ `nvidia-smi` 是**外部进程**（每次约几十毫秒 CPU），所以由调用方按 `probeMs`
 *    （默认 10s）驱动，**不是**每次判定都调。
 * ⚠️ 采样失败一律返回 `null`，**不抛** —— 一条探针挂掉不该让宠物闭嘴。
 *    R1 的意图是"别跟用户抢资源"，不是"随时准备罢工"。
 * ⚠️ GPU 一旦确认不可用就**不再反复尝试**（`gpuUsable = false`）——
 *    否则每 10s 白白起一个必然失败的进程。
 */
import { execFile } from 'node:child_process';
import { cpus } from 'node:os';

/** 单次 `nvidia-smi` 的超时；超了就当这条线不可用 */
const GPU_TIMEOUT_MS = 2_000;

export function createLoadProbe(options = {}) {
  const gpuCommand = options.gpuCommand ?? 'nvidia-smi';
  const gpuArgs = options.gpuArgs ?? ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'];
  const timeoutMs = options.timeoutMs ?? GPU_TIMEOUT_MS;

  /** 上一次的累计 CPU 时间。第一次采样没有参照，只能返回 0（而不是瞎报一个数）。 */
  let previous = null;
  /** GPU 命令可用与否。一旦确认不可用就不再试。 */
  let gpuUsable = true;

  const readCpu = () => {
    let idle = 0;
    let total = 0;
    for (const cpu of cpus()) {
      const times = cpu.times;
      idle += times.idle;
      total += times.user + times.nice + times.sys + times.idle + times.irq;
    }
    if (previous === null) {
      previous = { idle, total };
      return 0;
    }
    const deltaTotal = total - previous.total;
    const deltaIdle = idle - previous.idle;
    previous = { idle, total };
    if (deltaTotal <= 0) return 0;
    const busy = (deltaTotal - deltaIdle) / deltaTotal;
    return busy < 0 ? 0 : (busy > 1 ? 1 : busy);
  };

  const readGpu = () =>
    new Promise((resolve) => {
      if (!gpuUsable) {
        resolve(null);
        return;
      }
      execFile(gpuCommand, gpuArgs, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
        if (error) {
          gpuUsable = false;
          resolve(null);
          return;
        }
        // 多卡时只看第一张 —— 本项目的目标是"别跟主力负载抢"，第一张通常就是主力
        const first = String(stdout).trim().split(/\r?\n/)[0] ?? '';
        const value = Number.parseFloat(first);
        if (!Number.isFinite(value)) {
          resolve(null);
          return;
        }
        resolve(Math.max(0, Math.min(1, value / 100)));
      });
    });

  return {
    /** @returns {Promise<{cpu:number, gpu:number|null}>} 占用率 0..1 */
    read: async () => ({ cpu: readCpu(), gpu: await readGpu() }),
    /** GPU 这条线现在能不能用（调用方据此**留痕**：R3） */
    gpuAvailable: () => gpuUsable,
    /** 测试用：清掉 CPU 基线与 GPU 的"不可用"记忆 */
    reset: () => {
      previous = null;
      gpuUsable = true;
    },
  };
}
