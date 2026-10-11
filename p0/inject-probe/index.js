/**
 * 注入探针 —— 验证「让模型用中文思考」能不能由我们自己在插件里做。
 *
 * 背景：P2 实测发现模型的思考正文**默认是英文**（ASCII 67.3% / 中文 5.2%），
 * 而 D10 定的音色是中文音色。社区有插件能把它掰成中文，本探针用来确认
 * **我们自己也能做**（不必让用户另装一个插件）。
 *
 * 机制（读第一方源码得出，非猜测）：
 *   `ctx.systemPrompt.section({ name, order, text })`
 *   —— 第一方自己就在用（`dsh-app-boot` 的 addHarnessSourceSection），
 *      官方插件开发指南 practices.md 也明确推荐此 API。
 *
 * 本文件是**推荐形态**，两个刻意的选择：
 *
 *   1. **不把 systemPrompt 放进声明式 `inject`**，改用 `ctx.inject([...], cb)`。
 *      声明式 inject 是"硬等待"：宿主 profile 里没有 systemPrompt 服务时，
 *      插件会整个不激活（桌宠也不显示）。官方指南原话——
 *      "Put optional services in inject or ctx.inject([...], ...) so the plugin
 *       stays inactive in profiles without them instead of throwing."
 *      同为软探测的第一方先例：`dsh-app-boot` 的 `ctx.get('systemPrompt')` + 未定义即返回。
 *
 *   2. **section 名用自己的前缀**（`think-voice:`），**不得**与社区插件同名。
 *      插件级 ctx 的 scope 是 undefined ⇒ 落在 `ScopedLayers.global` 层；
 *      `NamedEntries.insert()` 对同层同名直接 `throw duplicateError`。
 *      即：若我们也叫 `chinese-thinking`，用户一旦同时装了社区插件，
 *      两个插件的 section 注册会撞名抛错。
 */
export const name = 'inject-probe';

/** 刻意留空：插件主体不因 systemPrompt 缺失而失效（见文件头第 1 条） */
export const inject = [];

/** 与社区插件 @max-null/dsh-chinese-thinking 同文，便于横向对照 */
export const PROMPT_TEXT = '始终使用中文进行思考和回复，无论用户使用什么语言。';

export function apply(ctx) {
  ctx.inject(['systemPrompt'], (host) => {
    host.effect(
      () =>
        host.systemPrompt.section({
          name: 'think-voice:reasoning-language',
          // -90 落在 harness:identity(-1000) 之后、deployment:persona-prefix(0) 之前，
          // 即"模型读到的最早一条行为指令"。与社区插件取同一位置。
          order: -90,
          text: PROMPT_TEXT,
        }),
      'inject-probe: reasoning language',
    );
  });
}
