/**
 * `lib/core/load-gate.js` — 领域层：负载闸的**判定**（纯逻辑）
 *
 * DESIGN §7.2 的「静默档」：检测到系统高负载时自动降为静默
 * （**只显示气泡文字，不合成、不播放**），负载回落自动恢复。
 *
 * 为什么判定单独成一个模块、不塞进 `speech-planner`：
 *   - 采样（`lib/infra/load-probe.js`）与判定是两件事：前者依赖这台机器，
 *     后者是纯规则。分开之后"持续 10s 才算数""回落也要防抖"这些规则
 *     可以用假时钟直接单测，**不必真把 CPU 跑满**去验。
 *   - `speech-planner` 管的是节奏（20s 频率闸，D3），那是产品口味；
 *     这道闸管的是"别跟用户的主力负载抢机器"（红线 R1），性质不同。
 *
 * ⚠️ D7 的默认值（`cpu 0.5 / gpu 0.5 / sustain 10s`）是**设计默认**，不是实测标定。
 *    真机噪声大（编译一跑 CPU 就满），所以两个阈值都留成可配。
 */

/** D7 默认：CPU ≥ 50% 或 GPU ≥ 50%，**持续** 10s ⇒ 静默；回落持续 10s ⇒ 恢复 */
export const DEFAULT_LIMITS = Object.freeze({
  cpu: 0.5,
  gpu: 0.5,
  /** 超阈值要**持续**这么久才判定为过载（防"编译时抖一下就闭嘴"） */
  sustainMs: 10_000,
  /** 回落也要持续这么久才恢复（防在阈值上下反复横跳） */
  recoverMs: 10_000,
});

/**
 * 造一个负载闸。
 *
 * @param {object} [options]
 * @param {object} [options.limits] 覆盖 `DEFAULT_LIMITS` 的任意项
 */
export function createLoadGate(options = {}) {
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...(options.limits ?? {}) });

  let silent = false;
  /** 第一次超阈值的时刻；未超时为 null */
  let overSince = null;
  /** 静默期间第一次回落的时刻；非静默时为 null */
  let okSince = null;

  /** 这次采样踩了哪条线（都没踩返回 null）。样本残缺时**不判过载**。 */
  const breach = (sample) => {
    const cpu = sample !== null && typeof sample === 'object' ? sample.cpu : undefined;
    const gpu = sample !== null && typeof sample === 'object' ? sample.gpu : undefined;
    if (typeof cpu === 'number' && Number.isFinite(cpu) && cpu >= limits.cpu) return 'cpu';
    // GPU 可能是 null（没有 nvidia-smi）—— 那只是"这条线拿不到"，不是"这条线踩了"
    if (typeof gpu === 'number' && Number.isFinite(gpu) && gpu >= limits.gpu) return 'gpu';
    return null;
  };

  /** 只认**有限数**：`NaN` / `Infinity` 与"压根没拿到"同义，一律报 null */
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

  const report = (sample, reason, extra = {}) => ({
    silent,
    changed: false,
    reason,
    cpu: num(sample?.cpu),
    gpu: num(sample?.gpu),
    ...extra,
  });

  return {
    /**
     * 喂一次采样，推进状态机。
     *
     * @param {{cpu?:number, gpu?:number|null}} sample 占用率 0..1；`gpu` 可为 null
     * @param {number} now 注入时钟（毫秒）
     * @returns {{silent:boolean, changed:boolean, reason:string, cpu:number|null, gpu:number|null}}
     *   `changed` 只在**状态翻转**时为 true —— 调用方据此打日志，避免每次采样都刷屏。
     */
    judge(sample, now) {
      const hit = breach(sample);

      if (hit !== null) {
        okSince = null;
        if (overSince === null) overSince = now;
        if (!silent && now - overSince >= limits.sustainMs) {
          silent = true;
          return report(sample, hit, { silent: true, changed: true });
        }
        return report(sample, hit);
      }

      overSince = null;
      if (!silent) return report(sample, 'ok');

      if (okSince === null) okSince = now;
      if (now - okSince >= limits.recoverMs) {
        silent = false;
        return report(sample, 'recovered', { silent: false, changed: true });
      }
      return report(sample, 'recovering');
    },

    /** 现在该不该闭嘴 */
    silent: () => silent,

    /** 诊断快照 */
    state: () => ({ silent, overSince, okSince }),

    limits,
  };
}
