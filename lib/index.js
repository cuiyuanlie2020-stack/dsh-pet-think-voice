/**
 * dsh-think-voice-pet — host half.
 *
 * A self-contained Live2D desk-pet plugin for the DSH Web GUI. It is
 * deliberately independent of any other pet plugin: it discovers Live2D pet
 * directories itself, serves their model reference closure, serves the Live2D
 * runtime files, and answers one catalog endpoint the browser half renders.
 *
 * Discovery follows the DSH pet convention: every directory under
 * '$DSH_HOME/pets/<id>/' holding a pet.json whose 'renderer' is 'live2d'.
 * The model's declared reference closure (moc3, textures, motions, physics,
 * expressions) is the allow-list the asset route serves — a crafted '..'
 * segment can never match, and realpath containment is the second layer.
 *
 * The proprietary Cubism Core runtime is NEVER bundled or downloaded by this
 * plugin: it is read from the user-supplied
 * '$DSH_HOME/pets/.runtime/live2dcubismcore.min.js'.
 *
 * buildRoutes() is exported so the same route table can be mounted by the
 * DSH web server (apply) and by tests.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDisplayLayer } from './display.js'
import { desktopHint, desktopSupported, resolveDesktopBinary } from './desktop.js'
import { readSettings, writeSettings } from './settings.js'
import { SOUND_PHASES, MAX_SOUND_BODY, decodeSound, readSound, resetSound, writeSound } from './sound-files.js'
import { createThinkingPipeline } from './app/thinking-pipeline.js'
import { createLoadGate } from './core/load-gate.js'
import { DEFAULT_LANGUAGE, createVoiceResolver, injectionText, normalizePolicy } from './core/reasoning-language.js'
import {
  SPEECH_INTERVAL_MAX_MS, SPEECH_INTERVAL_MIN_MS, SPEECH_INTERVAL_MS, createSpeechPlanner,
} from './core/speech-planner.js'
import { createLoadProbe } from './infra/load-probe.js'
import { EDGE_MIME, createAudioCache, createTtsProvider } from './infra/tts/index.js'

export const name = 'think-voice-pet'

export const inject = ['webServer']

/** Browser-facing API base. */
export const API = '/api/think-voice-pet'

/**
 * 「思考语言注入」用的 system prompt section 名。
 *
 * ⚠️ **必须带自有前缀**（`think-voice:`）。插件级 `ctx` 的 scope 是 `undefined`
 * ⇒ 落在 `ScopedLayers.global` 层，而 `NamedEntries.insert()` 对**同层同名直接
 * `throw duplicateError`**。若我们也叫社区插件那个 `chinese-thinking`，
 * 用户一旦同时装了它，**两个插件的注册都会挂**。这条是实测踩出来的
 * （见 `p0/inject-probe/README.md` 坑 2）。
 */
export const LANGUAGE_SECTION = 'think-voice:reasoning-language'

/**
 * 注入位置。`-90` 落在 `harness:identity(-1000)` 之后、`deployment:persona-prefix(0)`
 * 之前 —— 即"模型读到的最早一条行为指令"，与社区同类插件取同一位置。
 */
const LANGUAGE_ORDER = -90

/** Size ceilings per served file class, in bytes. */
const CAP_JSON = 64 * 1024
const CAP_IMAGE = 24 * 1024 * 1024
const CAP_MODEL = 48 * 1024 * 1024
const CAP_RUNTIME = 24 * 1024 * 1024

const MIME = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.json': 'application/json; charset=utf-8',
  '.moc3': 'application/octet-stream',
  '.js': 'application/javascript; charset=utf-8',
}

/** $DSH_HOME (defaults to ~/.dsh). */
export function dshHome() {
  const raw = process.env.DSH_HOME
  return raw !== undefined && raw.trim() !== '' ? raw.trim() : join(homedir(), '.dsh')
}

/** Directory holding every installed pet. */
export function petsRoot() {
  return join(dshHome(), 'pets')
}

/** Directory holding the user-supplied Live2D runtime files. */
export function runtimeDir() {
  return join(petsRoot(), '.runtime')
}

/** Package root of this plugin (lib/ -> package root), resolved once. */
let packageRoot
export function pluginRoot() {
  packageRoot ??= fileURLToPath(new URL('..', import.meta.url))
  return packageRoot
}

/** Plain JSON read that never throws. */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Safe relative path: no absolute paths, no backslashes, no traversal, plain segments. */
export function safeRel(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const value = raw.trim()
  if (value.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(value) || /^[\\/]/.test(value)) return undefined
  const segments = value.split('/').filter((segment) => segment !== '')
  if (segments.length === 0) return undefined
  if (segments.some((segment) => segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment))) return undefined
  return segments.join('/')
}

/**
 * The reference closure of one Cubism model3.json — exactly the files the
 * asset route may serve for the pet that declares it.
 */
export function modelClosure(model3) {
  const out = new Set()
  if (typeof model3 !== 'object' || model3 === null) return out
  const refs = model3.FileReferences
  if (typeof refs !== 'object' || refs === null) return out
  const push = (raw) => {
    const safe = safeRel(raw)
    if (safe !== undefined) out.add(safe)
  }
  if (refs.Moc !== undefined) push(refs.Moc)
  if (Array.isArray(refs.Textures)) refs.Textures.forEach(push)
  for (const key of ['Physics', 'Pose', 'DisplayInfo', 'UserData']) if (refs[key] !== undefined) push(refs[key])
  if (Array.isArray(refs.Expressions)) {
    for (const expression of refs.Expressions) {
      if (typeof expression === 'object' && expression !== null) push(expression.File)
    }
  }
  if (typeof refs.Motions === 'object' && refs.Motions !== null) {
    for (const motions of Object.values(refs.Motions)) {
      if (!Array.isArray(motions)) continue
      for (const motion of motions) {
        if (typeof motion === 'object' && motion !== null) push(motion.File)
      }
    }
  }
  return out
}

/**
 * Validate a pet's declared dress-up slots.
 *
 * Anything malformed is dropped rather than passed on: the browser half renders
 * these straight into buttons, so a slot without an id, or an option without an
 * expression, would produce a dead control. An empty result simply means the pet
 * has no dress-up panel, which is the right outcome for a model that needs none.
 */
/**
 * Validate a procedural sweep.
 *
 * A sweep drives model parameters from a generated curve instead of from a
 * baked motion. Only the channels the pet actually names are kept, so a typo in
 * one axis cannot silently produce a stationary hand.
 */
function normaliseSweep(raw) {
  if (typeof raw !== 'object' || raw === null) return null
  const axes = {}
  for (const key of ['x', 'y', 'z', 'rz']) {
    if (typeof raw[key] === 'string' && raw[key].trim() !== '') axes[key] = raw[key].trim()
  }
  if (Object.keys(axes).length === 0) return null
  const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
  return {
    ...axes,
    ampX: num(raw.ampX, 16),
    ampY: num(raw.ampY, 8),
    ampZ: num(raw.ampZ, 6),
    // One full trace of the loop, in milliseconds. The pen never lifts: the
    // path closes on itself, which is what makes it read as flowing rather
    // than as a series of strokes being snapped back to the margin.
    loopMs: num(raw.loopMs, 2600),
    // Optional slow drift, so a long-running loop does not look pinned to one
    // spot. 0 keeps it a pure closed curve.
    driftMs: num(raw.driftMs, 0),
    driftY: num(raw.driftY, 0),
  }
}

function normaliseSlots(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const slot of raw) {
    if (typeof slot !== 'object' || slot === null) continue
    const id = typeof slot.id === 'string' ? slot.id.trim() : ''
    if (id === '') continue
    const options = []
    for (const option of Array.isArray(slot.options) ? slot.options : []) {
      if (typeof option !== 'object' || option === null) continue
      // An option may need SEVERAL expressions: this model's 白魔爪 is
      // 魔爪换色 layered on 桌面粉魔爪, and the recolour alone renders nothing
      // because there is no claw to recolour. Accept either shape so a pet can
      // write the common single case without an array.
      const raw = Array.isArray(option.expressions)
        ? option.expressions
        : (typeof option.expression === 'string' ? [option.expression] : [])
      const expressions = []
      for (const name of raw) {
        if (typeof name !== 'string') continue
        const trimmed = name.trim()
        if (trimmed !== '' && !expressions.includes(trimmed)) expressions.push(trimmed)
      }
      // An option may also drive a MOTION, because some of this model's actions
      // sit at the same level as an expression: 吹泡泡糖 belongs with the mouth,
      // 掏出手机 and 挤番茄酱 with the hand. `requires` lists expressions that must
      // be on for the action to make sense (挤番茄酱 needs 蛋包饭 first).
      const motion = typeof option.motion === 'string' && option.motion.trim() !== ''
        ? option.motion.trim()
        : null
      const requires = []
      for (const name of Array.isArray(option.requires) ? option.requires : []) {
        if (typeof name === 'string' && name.trim() !== '' && !requires.includes(name.trim())) {
          requires.push(name.trim())
        }
      }
      // Slots this option must RESET. 写本本 is a right-hand action that needs the
      // left hand empty first, and "empty" is another slot's choice, so the
      // option has to be able to clear it.
      const clears = []
      for (const id of Array.isArray(option.clears) ? option.clears : []) {
        if (typeof id === 'string' && id.trim() !== '' && !clears.includes(id.trim())) clears.push(id.trim())
      }
      // A SWEEP is an animation this plugin generates, for parameters the model
      // left unanimated. This model ships 点菜手X/Y/Z (pointX/pointY/pointY2) with
      // a ±30 range and NOTHING driving them — the author meant the hand to
      // follow the mouse and never wired it up. Writing a curve per frame turns
      // them into a hand that actually writes on the tablet.
      // Options that cannot be worn together, named by their LABEL. 吐魂 and
      // 吹泡泡糖 write different parameters, so nothing in the engine stops them
      // overlapping — but the soul leaving the mouth on top of a bubble-gum
      // pucker is one mouth doing two things.
      const conflicts = []
      for (const label of Array.isArray(option.conflicts) ? option.conflicts : []) {
        if (typeof label === 'string' && label.trim() !== '' && !conflicts.includes(label.trim())) {
          conflicts.push(label.trim())
        }
      }
      // Pairs and breaks, for options that travel with (or rule out) another
      // slot's choice: 喵喵手 only makes sense with the cat sticker on, and any
      // other hand pose means the sticker should come off.
      const pairs = {}
      if (typeof option.pairs === 'object' && option.pairs !== null) {
        for (const [slotId, label] of Object.entries(option.pairs)) {
          if (typeof slotId === 'string' && typeof label === 'string' && label !== '') pairs[slotId] = label
        }
      }
      const breaks = []
      for (const label of Array.isArray(option.breaks) ? option.breaks : []) {
        if (typeof label === 'string' && label.trim() !== '' && !breaks.includes(label.trim())) breaks.push(label.trim())
      }
      const sweep = normaliseSweep(option.sweep)
      // Fidget weighting. Most of the time the mouth should simply be normal,
      // and a couple of options should never come up on their own at all, so the
      // idle fidget needs more than a uniform draw.
      const fidgetOff = option.fidget === false
      const fidgetWeight = typeof option.fidgetWeight === 'number' && option.fidgetWeight > 0
        ? option.fidgetWeight
        : 1
      if (expressions.length === 0 && motion === null && sweep === null) continue
      options.push({
        label: typeof option.label === 'string' && option.label !== ''
          ? option.label
          : (expressions[0] ?? motion),
        expressions,
        ...(motion === null ? {} : { motion }),
        ...(requires.length === 0 ? {} : { requires }),
        ...(clears.length === 0 ? {} : { clears }),
        ...(sweep === null ? {} : { sweep }),
        ...(conflicts.length === 0 ? {} : { conflicts }),
        ...(Object.keys(pairs).length === 0 ? {} : { pairs }),
        ...(breaks.length === 0 ? {} : { breaks }),
        ...(fidgetOff ? { fidget: false } : {}),
        ...(fidgetWeight === 1 ? {} : { fidgetWeight }),
      })
    }
    if (options.length === 0) continue
    out.push({
      id,
      label: typeof slot.label === 'string' && slot.label !== '' ? slot.label : id,
      none: typeof slot.none === 'string' && slot.none !== '' ? slot.none : '无',
      // How strongly the idle fidget should prefer leaving this slot alone.
      // The mouth sets it high so the pet mostly looks normal.
      ...(typeof slot.fidgetNone === 'number' && slot.fidgetNone > 0 ? { fidgetNone: slot.fidgetNone } : {}),
      options,
    })
  }
  return out
}

/**
 * 名字里带这些字的部件算"头"：作者在 cdi3 里给每个部件起了中文名
 * （`Part46` = 脸蛋、`Part57/58` = 眼睛、`Part14` = 头发、`Part45/68` = 耳朵…）。
 */
const HEAD_PART_NAME_HINTS = /头|脸|面|眼|眉|嘴|耳|发|eye|face|hair|head|ear|brow|mouth|cheek|nose/i

/**
 * 名字里带这些字的部件算"尾巴/翅膀"（这只宠物有 15 个：狐狸尾 / 猫尾 / 狼尾 / 大翅膀…，
 * 都是可换的配件，同一时刻只有一个是显形的）。
 */
const TAIL_PART_NAME_HINTS = /尾|鳍|翅|翼|fin|tail|wing/i

/**
 * 从 cdi3 里按名字挑部件。
 *
 * 为什么要读 cdi3：摸头/摸尾巴要知道"哪些 drawable 是头、是尾巴"。原来浏览器半区用的是
 * 写死的英文正则（`face|eye|mouth|…`），而这只模型的 drawable id 是 `Part46` 这种 ——
 * **一个都匹配不上**，于是判定静默退化成"点哪都算头"。作者自己的中文名才是权威分类。
 *
 * @returns {string[]} 部件 id；没有 cdi3 或没挑到就是空数组（浏览器半区会退回旧行为）。
 */
function readPartsMatching(dir, modelPath, hints) {
  try {
    const base = modelPath.replace(/\.model3\.json$/i, '')
    const file = findCdi3(dir, base)
    if (file === undefined) return []
    const cdi3 = readJson(file)
    const parts = cdi3?.Parts
    if (!Array.isArray(parts)) return []
    const out = []
    for (const part of parts) {
      if (part === null || typeof part !== 'object') continue
      const id = typeof part.Id === 'string' ? part.Id : undefined
      if (id === undefined || id === '') continue
      const name = typeof part.Name === 'string' ? part.Name : ''
      if (!hints.test(name) && !hints.test(id)) continue
      out.push(id)
    }
    return out
  } catch {
    return []
  }
}

/**
 * 找 cdi3.json。
 *
 * 它**不在** model3.json 的引用里（那是 Cubism Editor 的元数据，运行时不读），所以只能
 * 按约定找：与模型同名的 `<base>.cdi3.json` 优先，其次模型旁边、再其次宠物目录和它的
 * 直接子目录 —— 这只宠物就放在 `model/` 子目录里，只在根目录找会一个都挑不到。
 */
function findCdi3(dir, base) {
  const direct = [join(dir, base + '.cdi3.json'), join(dir, 'model', base + '.cdi3.json')]
  for (const file of direct) {
    if (existsSync(file)) return file
  }
  const roots = [dir]
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules') roots.push(join(dir, entry.name))
    }
  } catch {
    /* 读不了就只用 dir 本身 */
  }
  for (const root of roots) {
    try {
      const hit = readdirSync(root).find((name) => name.toLowerCase().endsWith('.cdi3.json'))
      if (hit !== undefined) return join(root, hit)
    } catch {
      /* 跳过读不了的目录 */
    }
  }
  return undefined
}

/**
 * 互动反应候选：一串标签（动作的中文名，或表情名）。非字符串/空的都丢掉。
 */
function readReactionList(value) {
  return Array.isArray(value) ? value.filter((name) => typeof name === 'string' && name !== '') : []
}

/**
 * 部件 id → 作者给的中文名（`Part46` → `脸蛋`）。
 *
 * 诊断用（`drawableTable()`）：把 drawable 归到有意义的部件名下，才能一眼看出
 * "她身上真正在画尾巴的是哪个 drawable" —— 光看 `ArtMesh123` 是认不出来的。
 */
function readPartNames(dir, modelPath) {
  try {
    const base = modelPath.replace(/\.model3\.json$/i, '')
    const file = findCdi3(dir, base)
    if (file === undefined) return {}
    const parts = readJson(file)?.Parts
    if (!Array.isArray(parts)) return {}
    const out = {}
    for (const part of parts) {
      if (part === null || typeof part !== 'object') continue
      if (typeof part.Id !== 'string' || typeof part.Name !== 'string') continue
      if (part.Name !== '') out[part.Id] = part.Name
    }
    return out
  } catch {
    return {}
  }
}

/** Scan one pet directory into a catalog entry, or undefined when unusable. */
export function scanPet(dir, id) {
  const manifestFile = join(dir, 'pet.json')
  if (!existsSync(manifestFile)) return undefined
  const manifest = readJson(manifestFile)
  if (manifest === undefined || typeof manifest !== 'object' || manifest === null) return undefined
  if (manifest.renderer !== 'live2d') return undefined
  const block = manifest.live2d
  if (typeof block !== 'object' || block === null) return undefined
  const modelPath = safeRel(block.model)
  if (modelPath === undefined || !modelPath.endsWith('.model3.json')) return undefined
  const modelFile = join(dir, modelPath)
  if (!existsSync(modelFile)) return undefined
  const model3 = readJson(modelFile)
  if (model3 === undefined) return undefined
  const closure = modelClosure(model3)
  if (closure.size === 0) return undefined
  // The model descriptor itself rides the same route: the browser fetches it
  // first, then every file it names, so it belongs in the servable set.
  closure.add(modelPath)

  // Labels/categories are optional host-only metadata shipped beside the
  // manifest ('catalog.json'); the authoritative motion/expression lists
  // always come from the model itself, so a pet without one still lists
  // everything, just with the model's own names.
  const labels = readJson(join(dir, 'catalog.json')) ?? {}
  const labelFor = (kind, key) => {
    const list = labels[kind]
    if (!Array.isArray(list)) return undefined
    const hit = list.find((entry) => entry !== null && typeof entry === 'object' && entry.key === key)
    return hit === undefined ? undefined : hit
  }

  // Every motion entry carries its own duration and loop flag, read from the
  // motion3.json the model references. The browser half needs both: the
  // engine refuses to restart a still-active group+index, and a motion
  // flagged Loop never emits motionFinish — so playback has to be driven by
  // the model's own timing instead of by that event alone.
  const motions = []
  const motionGroups = model3.FileReferences?.Motions
  if (typeof motionGroups === 'object' && motionGroups !== null) {
    for (const [group, list] of Object.entries(motionGroups)) {
      if (!Array.isArray(list) || list.length === 0) continue
      const meta = labelFor('motions', group)
      const items = list.map((entry, index) => {
        const file = typeof entry === 'object' && entry !== null ? safeRel(entry.File) : undefined
        const motionMeta = file === undefined ? undefined : readJson(join(dir, file))
        const rawDuration = motionMeta?.Meta?.Duration
        // Every parameter the motion writes. The browser half needs this to
        // clean up after a one-shot action: a motion such as 吹泡泡糖 drives
        // its own mouth/pose parameters that the idle loop does NOT drive, so
        // once the motion stops its last written value stays on the model
        // forever unless something puts it back ("泡泡吹完嘴没还原").
        const params = []
        const curves = motionMeta?.Curves
        if (Array.isArray(curves)) {
          for (const curve of curves) {
            if (curve?.Target === 'Parameter' && typeof curve.Id === 'string' && curve.Id !== '') {
              params.push(curve.Id)
            }
          }
        }
        return {
          index,
          duration: typeof rawDuration === 'number' && rawDuration > 0 ? Math.round(rawDuration * 1000) : 0,
          loop: motionMeta?.Meta?.Loop === true,
          params,
        }
      })
      motions.push({
        group,
        count: items.length,
        label: meta?.label ?? group,
        category: meta?.category ?? 'action',
        items,
      })
    }
  }

  const expressions = []
  const expressionRefs = model3.FileReferences?.Expressions
  if (Array.isArray(expressionRefs)) {
    for (const reference of expressionRefs) {
      if (typeof reference !== 'object' || reference === null) continue
      const expressionName = typeof reference.Name === 'string' && reference.Name !== '' ? reference.Name : reference.File
      if (typeof expressionName !== 'string') continue
      const meta = labelFor('expressions', expressionName)
      // Ship each expression's own parameter writes.
      //
      // The engine's expression pipeline loads the file correctly (44
      // definitions, the right parameter count, weight 1) but never actually
      // moves a parameter, so nothing it plays is visible. The browser half
      // therefore applies these values itself through the same parameter
      // machinery it already uses for motions — which also gives the UI the
      // per-expression data it needs to work out which effects conflict.
      const file = safeRel(reference.File)
      const params = []
      if (file !== undefined) {
        let parsed
        try {
          parsed = readJson(join(dir, file))
        } catch {
          parsed = undefined
        }
        if (Array.isArray(parsed?.Parameters)) {
          for (const parameter of parsed.Parameters) {
            if (typeof parameter?.Id !== 'string' || parameter.Id === '') continue
            const value = Number(parameter.Value)
            if (!Number.isFinite(value)) continue
            const blend = parameter.Blend === 'Multiply' ? 'Multiply'
              : parameter.Blend === 'Overwrite' ? 'Overwrite' : 'Add'
            params.push({ id: parameter.Id, value, blend })
          }
        }
      }
      expressions.push({
        name: expressionName,
        label: meta?.label ?? expressionName,
        category: meta?.category ?? 'other',
        file: file ?? '',
        params,
      })
    }
  }

  return {
    id,
    displayName: typeof manifest.displayName === 'string' && manifest.displayName !== '' ? manifest.displayName : id,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    scale: typeof block.scale === 'number' && block.scale > 0 && block.scale <= 10 ? block.scale : 1,
    // The manifest's phase -> motion-group / expression maps (same keys the
    // catalog uses), so the browser half can retarget session phases per pet.
    motionsByPhase: typeof block.motions === 'object' && block.motions !== null ? block.motions : {},
    // Per-motion playback policy (hold / reset / prepend) declared by the pet.
    // See the browser half's motion controller: a model whose motion3.json all
    // say "Loop": true cannot express "play once and hold the pose" or "clean
    // up the mouth afterwards" on its own, so the pet says it here.
    motionOptions: typeof block.motionOptions === 'object' && block.motionOptions !== null ? block.motionOptions : {},
    expressionsByPhase: typeof block.expressions === 'object' && block.expressions !== null ? block.expressions : {},
    // Mutually exclusive dress-up slots. Several of the model's expressions are
    // switches for the same thing (three pairs of glasses, three stickers), so
    // the pet declares which may not be worn together; the browser half turns
    // that into a one-choice-per-slot panel.
    expressionSlots: normaliseSlots(block.expressionSlots),
    // Session phase -> a whole LOOK expressed in slot vocabulary
    // ({ whale: "头顶鲸", lhand: "画笔" }), so a phase drives several slots at
    // once instead of a single expression.
    looksByPhase: typeof block.looksByPhase === 'object' && block.looksByPhase !== null ? block.looksByPhase : {},
    // motion group -> { slotId: [acceptable option labels] }. A motion whose
    // premise is missing (a selfie with no phone out, a spray with no whale)
    // must not play at all, from ANY path: the panel, a fidget or a phase.
    motionGuards: typeof block.motionGuards === 'object' && block.motionGuards !== null ? block.motionGuards : {},
    // 头部 / 尾巴部件（部件 id）：摸头、摸尾巴按这些部件的**真实几何**判定。
    // 空数组 = 没 cdi3 或没挑到，浏览器半区退回旧行为。
    headParts: readPartsMatching(dir, modelPath, HEAD_PART_NAME_HINTS),
    tailParts: readPartsMatching(dir, modelPath, TAIL_PART_NAME_HINTS),
    // 部件 id → 中文名（诊断用，见客户端 drawableTable()）。
    partNames: readPartNames(dir, modelPath),
    // 台词：宠物自己的声音（问候 / 点击 / 摸头 / 摸尾巴 / 转晕 / 归位 / 每个相位）。
    // 用户能在设置里逐条改，改过的存浏览器；这里是**默认值**。
    lines: typeof block.lines === 'object' && block.lines !== null ? block.lines : {},
    // null 表示旧宠物没有声明提示音，浏览器半区才使用内置兜底。
    sounds: typeof block.sounds === 'object' && block.sounds !== null && !Array.isArray(block.sounds) ? block.sounds : null,
    // 互动反应候选（标签：动作的中文名或表情名）。摸头 / 摸尾巴 / 转晕各一组。
    patReactions: readReactionList(block.patReactions),
    tailReactions: readReactionList(block.tailReactions),
    spinReactions: readReactionList(block.spinReactions),
    // 摸鱼默认盯哪几个槽位。以前这六个是**写死在浏览器半区**的（"宠物自己的身子"），
    // 但宠物作者（和用户）会想改：这只宠物把「自拍」也放进了摸鱼池。写在这里之后，
    // "默认集合"也成了宠物自己声明的东西，用户加的槽位照样覆盖在上面。
    fidgetSlots: Array.isArray(block.fidgetSlots) ? block.fidgetSlots.filter((id) => typeof id === 'string') : [],
    // Motion groups that belong to the SLOT menu rather than the 动作 tab.
    // 掏出手机 and 吹泡泡糖 are slot choices now; listing them twice made the
    // same thing reachable two ways, and the tab copy could not hold a pose.
    hiddenMotions: Array.isArray(block.hiddenMotions) ? block.hiddenMotions.filter((m) => typeof m === 'string') : [],
    translate: {
      x: typeof block.translate?.x === 'number' ? block.translate.x : 0,
      y: typeof block.translate?.y === 'number' ? block.translate.y : 0,
    },
    dir,
    modelPath,
    modelUrl: API + '/asset/' + encodeURIComponent(id) + '/' + modelPath.split('/').map(encodeURIComponent).join('/'),
    closure,
    motions,
    expressions,
  }
}

/**
 * 随包宠物 pet.json 的**历史内容指纹**（SHA-256），一份一行。
 *
 * 只为一件事存在：认出"用户宠物目录里那份是我们**某一次发出去的**原样副本"。
 * 认出来才敢升级（`syncBundledPet`），认不出来就一个字都不碰。
 *
 * 为什么必须从 git 历史里现算、不能手抄：抄错一位的两种后果都是静默的 ——
 * 要么永远不升级（老用户拿不到新的默认值），要么把用户自己改过的副本覆盖掉。
 * 生成命令：`node tools/print-pet-hashes.mjs dsh-think-voice-pet/pets/ds-whale-girl/pet.json --at <提交> --code`
 * （每份内容取它**最后**出现的那个提交，否则第一次安装与仓库当时状态对不上）。
 *
 * 这是**冷启动**用的表：同步记录（`pets/.synced.json`）建立之后，判定就只看记录，
 * 这个表只在"目标没有记录"时才参与 —— 也就是所有老装机，以及第一次装新版本的人。
 * 因此每改一次随包宠物，都要把**改动之前那一版**的哈希补进来（改动之后那一版是目标，
 * 不需要进表）。
 */
const BUNDLED_PET_HASHES = {
  'ds-whale-girl': [
    // ef7fb1a：模型第一次随包分发（1.0.x，17 个槽位、5 个相位）
    '5421dee9d13ee60b91c341ab515bbef3fb8702a9791279c9a2f61124d4478b34',
    // 3f18b195：面板跟随宿主主题 + 自拍可配置
    '707049e3b8a05f3de5ddd49299bcb47fdd2ac1494209b7c710c1371be718bb27',
    // 9b62d727：自拍独立成槽、氛围拆三个、摸鱼不再擦掉手选
    '071a7bfe18b4882703a43f8a14dc7eded8d5aa08671dc3ecc4db220258e5be23',
    // 6c6b61e1（2.0.0）：把作者调好的值烘成宠物默认
    'e931e44a6589932688d7507b0d5e62ba4c0f9618492ec7fe644885117e61f12a',
    // 4b594ed3（2.2.0）：多接三个会话状态
    '88b86f32833882893e8ec10a9320bb4d9899a0211811d5a96544e4b97b804234',
    // 25c4d285（2.3.0 前）：台词 / 反应候选 / 摸鱼槽位
    '18840cd90fe70aa68632c45f77b4af1254595b5f963d261d2cbf34f6fbcaf579',
    // 1.0.1（2.3.0 ~ 2.3.2 随包的那份）：内容与上面那条相同，只是换了插件版本号
    '7c6cdb9c9f3d92636c388bffb3229c439cf01a65fe6a8a88499a8e4071f7884a',
    // 1.1.0（会话提示音进入随包宠物之前）
    '31eb2a210d3d99d2f2d53462b8a074ae22209579f7b8fcaa41dd5516e0a861b3',
  ],
}

/** 同步记录：哪个宠物是我们装的、装的是哪一版、装下去那份长什么样。 */
const SYNC_RECORD = '.synced.json'

/** 文件和 buffer 的 SHA-256（判定"这是不是我们发出去的原样"）。 */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 读同步记录；读不出来就当"没有"（老装机本来就没有）。 */
function readSyncRecord() {
  const parsed = readJson(join(petsRoot(), SYNC_RECORD))
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

function writeSyncRecord(record) {
  mkdirSync(petsRoot(), { recursive: true })
  writeFileSync(join(petsRoot(), SYNC_RECORD), JSON.stringify(record, null, 2) + '\n')
}

/** 点分数字比较：'1.1.0' > '1.0.1'。非数字段（rc / beta）只取数字部分。 */
export function compareVersions(a, b) {
  const parts = (raw) => String(raw ?? '').split('.').map((piece) => {
    const n = Number.parseInt(piece, 10)
    return Number.isFinite(n) ? n : 0
  })
  const left = parts(a)
  const right = parts(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const one = left[i] ?? 0
    const two = right[i] ?? 0
    if (one !== two) return one > two ? 1 : -1
  }
  return 0
}

/** 这份宠物目录里的 pet.json 是不是"某一次随包发出去的原样"。 */
function isPristineBundledManifest(petId, manifestPath, fingerprints) {
  let hash
  try {
    hash = sha256(readFileSync(manifestPath))
  } catch {
    return false
  }
  return (fingerprints[petId] ?? []).includes(hash)
}

/**
 * 把随包宠物装进用户的宠物目录，并在**确实是我们装的那份**过期时更新它。
 *
 * 以前宠物是仓库里单独一份，装插件的人还得自己再拷一次 —— 从插件市场装完
 * 「看不见宠物」就是这么来的（插件包里有代码，没有模型）。
 *
 * 为什么模型能随包、Cubism Core 不能：模型是 CC BY-NC-SA 4.0，且 Live2D 作者
 * 已明确授权本项目转载与开源（见 pets/ds-whale-girl/LICENSE）；Core 是 Live2D Inc.
 * 的专有软件，只允许从官方渠道取，所以它走 CDN 兜底那条路。
 *
 * **升级这一半是补上的**（原来只有"目标不存在才拷"）：插件目录会随
 * `dsh plugin add` / npm 更新，用户的宠物目录不会 —— 于是宠物**自己的默认值
 * 永远停在装它的那一天**。25c4d285 往 pet.json 里加的那批（台词 / 互动反应候选 /
 * 摸鱼槽位 / 新增的三个相位）就这么一直没到过老用户的桌面，症状是"互动只有台词
 * 不演反应、相位不弹台词、装扮少三个槽位"，而且**看起来完全像插件的 bug**。
 *
 * 三条判定，缺一条都会变成"静默覆盖用户数据"：
 *   1. 目标不存在 → 装一份（并把版本与内容指纹记进 `pets/.synced.json`）；
 *   2. 目标就是我们上次装下去的那一份（**内容指纹**对得上）→ 整份更新；
 *   3. 用户动过（指纹对不上）→ **一个字都不碰**。
 *
 * 第 2 条在冷启动时（记录出现之前装的副本）靠 `BUNDLED_PET_HASHES` 认人：
 * 内容与历史上任何一次随包分发**逐字节相同**才升级。改过名字/槽位/任何东西的副本
 * 哈希必然不同，所以"用户自己改过的宠物永远优先，绝不覆盖"这条没有被削弱。
 */
export function installBundledPets(options = {}) {
  const bundled = join(pluginRoot(), 'pets')
  if (!existsSync(bundled)) return
  // 冷启动指纹表可以被注入：测试要造一份"我们以前发过的旧副本"，但测试**不能**
  // 依赖生产表里的具体哈希（那样改一次表就得改测试，而且改错了也没人发现）。
  const fingerprints = options.fingerprints ?? BUNDLED_PET_HASHES
  let names = []
  try {
    names = readdirSync(bundled).filter((entry) => !entry.startsWith('.'))
  } catch {
    return
  }
  const record = readSyncRecord()
  const notes = []
  let dirty = false
  for (const name of names) {
    const source = join(bundled, name)
    const target = join(petsRoot(), name)
    try {
      if (!statSync(source).isDirectory()) continue
      const manifestPath = join(source, 'pet.json')
      if (!existsSync(manifestPath)) continue
      const version = String(readJson(manifestPath)?.version ?? '')
      const targetManifest = join(target, 'pet.json')

      if (!existsSync(target)) {
        mkdirSync(dirname(target), { recursive: true })
        cpSync(source, target, { recursive: true })
        record[name] = { version, hash: sha256(readFileSync(targetManifest)) }
        dirty = true
        continue
      }

      const synced = record[name]
      const same = existsSync(targetManifest) ? sha256(readFileSync(targetManifest)) : undefined
      const ours = (synced !== undefined && synced.hash === same)
        || isPristineBundledManifest(name, targetManifest, fingerprints)
      if (!ours) {
        // 用户自己改过：不动它。**要说出来** —— 沉默地不升级，用户看到的是
        // "插件更新了但没有任何变化"，比报错更难查。
        if (compareVersions(version, readJson(targetManifest)?.version) > 0) {
          notes.push(name + '：宠物目录里这份被改过，跳过更新（随包版本 ' + version
            + '，本地 ' + String(readJson(targetManifest)?.version ?? '?') + '）')
        }
        continue
      }
      // **升级与否只看内容**，不看版本号：版本号是宠物自己声明的，随包那份在同一个
      // 版本号下改过（补默认值就是这么发生的），只比版本号会让这次修订永远发不出去。
      // 反过来，"版本相同 + 内容相同"在这里就短路了，不会做无谓的整份重写。
      const bundledHash = sha256(readFileSync(manifestPath))
      if (same === bundledHash) continue

      // cpSync 是逐文件覆盖 —— 用户额外放进去的文件（自己的贴图、备注）不在随包
      // 那份里，所以留得住。
      // 「原先」那个版本号要**在覆盖之前**读：覆盖之后再读只会读到新的，日志就成了
      // "更新到 1.1.0（原先 1.1.0）"（第一次跑就写成了这样）。
      const was = String(readJson(targetManifest)?.version ?? '?')
      cpSync(source, target, { recursive: true })
      record[name] = { version, hash: bundledHash }
      dirty = true
      notes.push(name + '：宠物默认值更新到 ' + version + '（原先 ' + was + '）')
    } catch {
      /* 只读文件系统之类：让用户自己拷，别让整个目录扫描失败 */
    }
  }
  if (dirty) {
    try {
      writeSyncRecord(record)
    } catch {
      /* 记录写不进去只影响"下次少一次判定"，不影响这次已经装好的宠物 */
    }
  }
  if (notes.length > 0 && options.quiet !== true) {
    for (const note of notes) console.log('[think-voice-pet] ' + note)
  }
}

/** Build the live catalog from disk (fresh per request, so installs are picked up). */
export function buildCatalog() {
  installBundledPets()
  const root = petsRoot()
  if (!existsSync(root)) return []
  let names = []
  try {
    names = readdirSync(root).filter((entry) => !entry.startsWith('.'))
  } catch {
    return []
  }
  names.sort()
  const pets = []
  for (const entry of names) {
    const dir = join(root, entry)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const pet = scanPet(dir, entry)
    if (pet !== undefined) pets.push(pet)
  }
  return pets
}

/** realpath containment; a symlink escaping its root is refused. */
function contained(base, candidate) {
  try {
    const realBase = realpathSync(base)
    const realCandidate = realpathSync(candidate)
    return realCandidate === realBase || realCandidate.startsWith(realBase + sep) ? realCandidate : undefined
  } catch {
    return undefined
  }
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  response.writeHead(status, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
  })
  response.end(body)
}

/** Weak validator from size + mtime. */
function weakEtag(stat) {
  return '"' + stat.size.toString(16) + '-' + Math.round(stat.mtimeMs).toString(16) + '"'
}

/** Serve one file with containment, size ceiling and revalidation. */
function serveFile(request, response, base, file, cap) {
  const resolved = contained(base, file)
  if (resolved === undefined) {
    response.writeHead(403)
    response.end()
    return
  }
  let stat
  try {
    stat = statSync(resolved)
    if (!stat.isFile()) throw new Error('not a file')
    if (stat.size > cap) {
      response.writeHead(413)
      response.end()
      return
    }
  } catch {
    response.writeHead(404)
    response.end()
    return
  }
  const etag = weakEtag(stat)
  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304, { etag, 'cache-control': 'no-cache' })
    response.end()
    return
  }
  readFile(resolved).then((body) => {
    response.writeHead(200, {
      'content-type': MIME[extname(resolved).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(body.byteLength),
      'cache-control': 'no-cache',
      etag,
    })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    response.end(body)
  }, () => {
    response.writeHead(404)
    response.end()
  })
}

/** Loopback-only fence: the pet API never answers a non-local peer. */
function loopbackOnly(request) {
  const address = request.socket?.remoteAddress ?? ''
  return address === '' || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Split a request path into the segments after one known prefix. */
function segmentsAfter(pathname, prefix) {
  if (!pathname.startsWith(prefix + '/')) return undefined
  return pathname.slice(prefix.length + 1).split('/')
}

/** The catalog route (GET /api/think-voice-pet/catalog). */
function catalogRoute() {
  return {
    kind: 'exact',
    path: API + '/catalog',
    handler: (request, response) => {
      if (!loopbackOnly(request)) {
        response.writeHead(403)
        response.end()
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD' })
        response.end()
        return
      }
      sendJson(response, 200, {
        ok: true,
        coreUrl: API + '/runtime/live2dcubismcore.min.js',
        vendorUrl: API + '/runtime/live2d-vendor.js',
        pets: buildCatalog().map((pet) => ({
          id: pet.id,
          displayName: pet.displayName,
          description: pet.description,
          modelUrl: pet.modelUrl,
          scale: pet.scale,
          translate: pet.translate,
          motionsByPhase: pet.motionsByPhase,
          expressionsByPhase: pet.expressionsByPhase,
          expressionSlots: pet.expressionSlots,
          looksByPhase: pet.looksByPhase,
          motionGuards: pet.motionGuards,
          headParts: pet.headParts,
          tailParts: pet.tailParts,
          partNames: pet.partNames,
          lines: pet.lines,
          sounds: pet.sounds,
          patReactions: pet.patReactions,
          tailReactions: pet.tailReactions,
          spinReactions: pet.spinReactions,
          fidgetSlots: pet.fidgetSlots,
          hiddenMotions: pet.hiddenMotions,
          motionOptions: pet.motionOptions,
          motions: pet.motions,
          expressions: pet.expressions,
        })),
      })
    },
  }
}

/** The model reference-closure route (GET /api/think-voice-pet/asset/<id>/<path>). */
function assetRoute() {
  return {
    kind: 'prefix',
    path: API + '/asset',
    handler: (request, response) => {
      if (!loopbackOnly(request)) {
        response.writeHead(403)
        response.end()
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405)
        response.end()
        return
      }
      let pathname
      try {
        pathname = new URL(request.url ?? '/', 'http://pet.local').pathname
      } catch {
        response.writeHead(400)
        response.end()
        return
      }
      const segments = segmentsAfter(pathname, API + '/asset')
      if (segments === undefined || segments.length < 2) {
        response.writeHead(404)
        response.end()
        return
      }
      let id
      let rel
      try {
        id = decodeURIComponent(segments[0])
        rel = segments.slice(1).map(decodeURIComponent).join('/')
      } catch {
        response.writeHead(400)
        response.end()
        return
      }
      const pet = buildCatalog().find((candidate) => candidate.id === id)
      // The closure probe is a Set lookup on scan-time normalized paths, so a
      // crafted '..' / '.' segment can never match a real file.
      if (pet === undefined || !pet.closure.has(rel)) {
        response.writeHead(404)
        response.end()
        return
      }
      const ext = extname(rel).toLowerCase()
      const cap = ext === '.json' ? CAP_JSON : (ext === '.moc3' ? CAP_MODEL : CAP_IMAGE)
      serveFile(request, response, pet.dir, join(pet.dir, rel), cap)
    },
  }
}

/**
 * Live2D 官方托管的 Cubism Core。
 *
 * 这份运行时是 Live2D 的专有软件，插件**不内置也不代下**（授权要求），但
 * **用户的机器可以从 Live2D 自己的 CDN 取** —— 官方 SDK 文档就是让使用者在页面里
 * 引这一行。取到之后缓存进 runtimeDir()，之后离线也能用。
 *
 * 有了这条兜底，从插件市场装完就能直接用，不必先去找 Cubism Core 放哪。
 */
const CORE_CDN = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js'

/** 本地没有 Core 时：去 Live2D 官方 CDN 拿一份，顺手缓存到本地。 */
async function fetchCoreFromCdn(response, cachePath) {
  try {
    const upstream = await fetch(CORE_CDN, { redirect: 'follow' })
    if (!upstream.ok) throw new Error('HTTP ' + upstream.status)
    const bytes = Buffer.from(await upstream.arrayBuffer())
    // 拿回来的必须真是一份 JS：否则多半是被网关/登录页替换了。
    if (bytes.length < 10000 || !bytes.includes('Live2DCubismCore')) {
      throw new Error('unexpected payload: ' + bytes.length + ' bytes')
    }
    try {
      mkdirSync(dirname(cachePath), { recursive: true })
      writeFileSync(cachePath, bytes)
    } catch {
      /* 缓存写不进去不影响这一次：直接把它发出去 */
    }
    response.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': String(bytes.length),
      'cache-control': 'public, max-age=86400',
      'x-live2d-core-source': 'cdn',
    })
    response.end(bytes)
  } catch (error) {
    sendJson(response, 502, {
      ok: false,
      error: 'cubism-core-unavailable',
      detail: String(error?.message ?? error),
      hint: 'Cubism Core 是 Live2D 的专有运行时，本插件不内置。可以让这台机器能访问 '
        + CORE_CDN + '，或自行下载后放到 ' + join(runtimeDir(), 'live2dcubismcore.min.js'),
    })
  }
}

/** The runtime route (user-supplied Cubism Core + plugin vendor bundle). */
function runtimeRoute() {
  const vendorBase = join(pluginRoot(), 'lib')
  const coreBase = runtimeDir()
  return {
    kind: 'prefix',
    path: API + '/runtime',
    handler: (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405)
        response.end()
        return
      }
      let pathname
      try {
        pathname = new URL(request.url ?? '/', 'http://pet.local').pathname
      } catch {
        response.writeHead(400)
        response.end()
        return
      }
      const segments = segmentsAfter(pathname, API + '/runtime')
      if (segments === undefined || segments.length !== 1) {
        response.writeHead(404)
        response.end()
        return
      }
      // An exact-name allow-list: a segment carrying a separator never matches.
      const runtimeName = segments[0]
      let base
      if (runtimeName === 'live2dcubismcore.min.js') base = coreBase
      else if (runtimeName === 'live2d-vendor.js') base = vendorBase
      else {
        response.writeHead(404)
        response.end()
        return
      }
      const file = join(base, runtimeName)
      if (!existsSync(file)) {
        // Cubism Core 走官方 CDN 兜底：用户不用再自己找文件。
        if (runtimeName === 'live2dcubismcore.min.js') {
          void fetchCoreFromCdn(response, file)
          return
        }
        sendJson(response, 404, { ok: false, error: 'runtime-file-missing', file: runtimeName })
        return
      }
      serveFile(request, response, base, file, CAP_RUNTIME)
    },
  }
}


// ---------------------------------------------------------------- activity
//
// Session-activity mirror (requirement #4): the pet follows the DSH agent's
// real lifecycle instead of only reacting to clicks.
//
// The event vocabulary is the official one (verified against dsh-agent's
// runtime-types): 'agent/status' carries idle <-> running, 'agent/turn-stopping'
// fires when a turn finishes, 'agent/error' on failure, and 'approval/request'
// (a waterfall event, so it must be resumed) while the user is being asked.
//
// Delivery is a same-origin SSE stream rather than polling: transitions are
// pushed the moment they happen, and an idle page costs only a keep-alive
// comment frame.

/** The activity phases the browser half understands. */
export const ACTIVITY_PHASES = [
  'idle', 'thinking', 'waiting', 'asking', 'tool', 'helper', 'queued', 'done', 'failed',
]

/** How long the 'done' celebration is held before falling back to idle. */
const DONE_HOLD_MS = 3500

/** "你的消息排队了"给一个短促的收到反应，然后回到原来在演的东西。 */
const QUEUED_HOLD_MS = 1600

/** SSE keep-alive interval. */
const SSE_PING_MS = 30000

/**
 * The activity hub: folds DSH session events into one coarse phase, and fans
 * that phase out to every subscribed SSE response.
 */
export class ActivityHub {
  constructor() {
    this.phase = 'idle'
    this.detail = ''
    this.listeners = new Set()
    this.holdTimer = undefined
  }

  /** Current snapshot (sent as the first frame of every stream). */
  snapshot() {
    return { phase: this.phase, detail: this.detail, at: Date.now() }
  }

  /** Subscribe one SSE response; returns the unsubscribe function. */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(phase, detail = '') {
    if (this.phase === phase && this.detail === detail) return
    this.phase = phase
    this.detail = detail
    this.emit()
  }

  /**
   * 演一个**短促反应**相位，过一会儿自动回落到 `fallback`。
   *
   * `done`（庆祝）和 `queued`（收到你排队的消息）都是这一类：宠物演一下，然后回到
   * 它该在的地方。回落之前会确认相位没被别人接管 —— 这段时间里工具开始了、或者
   * 新一轮说话了，就不要再把它拽回旧的 fallback。
   */
  hold(phase, ms, fallback = 'idle') {
    if (this.holdTimer !== undefined) clearTimeout(this.holdTimer)
    this.set(phase, '')
    this.holdTimer = setTimeout(() => {
      this.holdTimer = undefined
      if (this.phase === phase) this.set(fallback, '')
    }, ms)
    // Keep the process free to exit; the timer is purely cosmetic.
    this.holdTimer?.unref?.()
  }

  /**
   * Enter the 'done' celebration and fall back to idle after a hold, so the
   * pet visibly finishes a turn instead of snapping straight back.
   */
  celebrate() {
    this.hold('done', DONE_HOLD_MS, 'idle')
  }

  emit() {
    const payload = this.snapshot()
    for (const listener of this.listeners) {
      try {
        listener(payload)
      } catch {
        /* a dead stream must not break the others */
      }
    }
  }

  /**
   * 广播一个**非相位**的帧（DESIGN §6.4 新增的 `speak`）。
   *
   * 与 `emit()` 的分工：`emit()` 发的是「当前状态快照」（每次都是全量覆盖语义），
   * 而这个是**一次性事件**，浏览器收到就该显示一次。
   *
   * ⚠️ 刻意**不动已有帧的形状**：老的相位帧仍然没有 `type` 字段。新增帧一律带
   * `type`，于是浏览器侧的判别规则简单可靠 —— "有 type 就按 type 分派，
   * 没有 type 就当相位快照"。老版本浏览器遇到不认识的 type 会自然忽略。
   */
  broadcast(frame) {
    for (const listener of this.listeners) {
      try {
        listener(frame)
      } catch {
        /* a dead stream must not break the others */
      }
    }
  }

  dispose() {
    if (this.holdTimer !== undefined) {
      clearTimeout(this.holdTimer)
      this.holdTimer = undefined
    }
    this.listeners.clear()
  }
}

/**
 * How long the pet stays in the 'tool' phase after the last tool returns.
 *
 * Long enough to bridge the gap between consecutive tool calls in one turn
 * (otherwise the phase flaps and the animation restarts constantly), short
 * enough that the pet visibly settles once the work really stops.
 */
const TOOL_IDLE_MS = 1200

/**
 * Fold the official DSH events into hub phases. Every subscription is optional
 * at runtime: an older host that lacks one simply keeps mirroring the others.
 */
export function attachActivityEvents(ctx, hub) {
  const on = (event, handler) => {
    try {
      ctx.on(event, handler)
    } catch {
      /* host without this event */
    }
  }
  // Waterfall events only continue if the handler resumes the chain, so a
  // throw here would silently break tool execution for the whole session.
  const onWaterfall = (event, handler) => {
    try {
      ctx.on(event, (...args) => {
        try {
          return handler(...args)
        } catch {
          // Never swallow the chain: hand control straight on.
          const next = args[args.length - 1]
          return typeof next === 'function' ? next() : undefined
        }
      })
    } catch {
      /* host without this event */
    }
  }
  on('agent/status', (payload) => {
    const status = payload?.status
    if (status === 'running') hub.set('thinking', '')
    else if (status === 'idle' && hub.phase !== 'done') hub.set('idle', '')
  })
  on('agent/turn-stopping', () => hub.celebrate())
  on('agent/error', () => hub.set('failed', ''))
  // approval/request is a waterfall event: it MUST resume the chain.
  on('approval/request', (_request, next) => {
    hub.set('waiting', '')
    return typeof next === 'function' ? next() : undefined
  })

  // Tool activity refines the generic 'thinking' phase while a turn runs.
  //
  // The obvious-looking event name for this is 'tool/call', but that is a
  // SESSION LOG event (a record appended to the transcript), not a cordis
  // lifecycle event — subscribing to it never fires, which is why the pet
  // appeared to ignore tool activity entirely. The live hooks are the
  // 'tools/*' waterfall events, which carry the ToolExecution itself.
  //
  // A turn usually runs MANY tools back to back, so reverting the instant one
  // returns would flap tool -> thinking -> tool several times a second, and each
  // transition restarts the pet's animation. The revert is therefore debounced:
  // it only happens once the tools actually stop arriving.
  let toolIdleTimer
  onWaterfall('tools/pre-execute', (exec, next) => {
    if (toolIdleTimer !== undefined) {
      clearTimeout(toolIdleTimer)
      toolIdleTimer = undefined
    }
    const name = exec?.name
    hub.set('tool', typeof name === 'string' ? name : '')
    return next()
  })
  onWaterfall('tools/post-execute', (_exec, _result, next) => {
    if (toolIdleTimer !== undefined) clearTimeout(toolIdleTimer)
    toolIdleTimer = setTimeout(() => {
      toolIdleTimer = undefined
      // Only step down if nothing else has taken over in the meantime.
      if (hub.phase === 'tool') hub.set('thinking', '')
    }, TOOL_IDLE_MS)
    return next()
  })

  // ---- DSH 0.1.7 里另外三个值得接的状态 --------------------------------------
  //
  // 事件词汇表在 0.1.7 里已经不小（`*.d.ts` 里声明了 100 个可订阅事件），但只有一部分
  // 能翻译成"宠物该演什么"。挑的标准是**它填的是不是一个真实的空档**：
  //
  //   asking  ← user-questions/request：以前"在等你回答问题"这段时间宠物还在演"干活"，
  //             看着像它没停过 ✗ —— 这是最大的一个空档；
  //   helper  ← subagent/start|end：子代理是**长活**（几分钟），和一次普通工具调用
  //             混在一起看不出区别；
  //   queued  ← agent/inbox/inserted：你发的话在它忙的时候插进来，现在至少给个"收到"。
  //
  // 没接的（评估过，不值得）：`fs/write-intent` / `edit-intent` —— 宠物在 tool 相位已经
  // 演「写本本」了，再拆一个 editing 和它重复；`workflow/*` —— 工作流本身是工具调用，
  // 已被 tool 覆盖（`workflow/phase` 的标题倒是可以当 detail，但宠物目前不显示 detail）；
  // `agent/status` 只有 idle / running 两个值，给不出更细的东西。

  // `user-questions/request` 是 waterfall：链一直挂到**你把问题答完**才 resume，所以
  // 这个相位正好等于"卡在等你"的那段，不用自己计时。
  onWaterfall('user-questions/request', (_request, next) => {
    hub.set('asking', '')
    const answered = typeof next === 'function' ? next() : undefined
    const back = () => {
      if (hub.phase === 'asking') hub.set('thinking', '')
    }
    if (answered !== null && typeof answered?.then === 'function') {
      answered.then(back, back)
      return answered
    }
    back()
    return answered
  })
  on('subagent/start', (info) => {
    const label = typeof info?.name === 'string'
      ? info.name
      : (typeof info?.label === 'string' ? info.label : '')
    hub.set('helper', label)
  })
  on('subagent/end', () => {
    if (hub.phase === 'helper') hub.set('thinking', '')
  })
  on('agent/inbox/inserted', () => {
    // 回到"刚才在演的那个"（可能是 tool / asking，也可能是 idle）——不要一律回 idle，
    // 那会让一个正在跑工具的回合看起来停了。
    const previous = hub.phase
    hub.hold('queued', QUEUED_HOLD_MS, previous === 'queued' ? 'thinking' : previous)
  })
}

/** 留痕输出（R3：降级/跳过必须说出来，不得静默）。走宿主控制台。 */
function logThinking(level, message) {
  const prefix = level === 'warn' ? '[think-voice-pet][warn] ' : '[think-voice-pet] '
  console.log(prefix + message)
}

/** 把 0..1 的占用率打成人看的百分比；拿不到就 `n/a`（别打成 `null%`） */
function formatPercent(value) {
  return typeof value === 'number' ? Math.round(value * 100) + '%' : 'n/a'
}

/**
 * 把「思考语言」注入到系统提示（D10 的落地；机制与实验见 DESIGN §9.3）。
 *
 * 这是本项目**唯一一处写用户环境**的地方 —— 插件其余部分只读思考（红线 R2）。
 * 所以三条约束是硬性的，不是"最好有"：
 *
 *   ① **默认关**：只有设置里显式选了 `zh` / `en` 才注入；`auto` ⇒ 一个字都不加。
 *   ② **留痕**（R3）：开启与关闭各记一条 info，用户能在宿主日志里看见
 *      "这个插件动了我的系统提示"。
 *   ③ **可一键关**（R5）：改回 `auto` 时**立即撤销** section，不必重启。
 *
 * ⚠️ 三个实测踩出来的坑（完整记录见 `p0/inject-probe/README.md`）：
 *
 *   1. **不能把 `systemPrompt` 写进声明式 `inject`**。那是"硬等待"：宿主 profile 里没有
 *      该服务时，**插件整个不激活** —— 桌宠都不显示。官方指南那句
 *      "Put optional services in inject … so the plugin stays inactive in profiles
 *      without them instead of throwing" 说的是"别抛错"，但对本插件更要紧的是
 *      **主体功能与它无关**（朗读不需要 systemPrompt），所以正确答案是
 *      `ctx.inject([...], cb)` **软探测**：服务不在 ⇒ 不注入，其余照常。
 *   2. 插件包 `package.json` 缺 `peerDependencies` 里对
 *      `@deepseek-ai/dsh-system-prompt` 的声明时，报的是
 *      `REQUEST_EXTENSION: DeepSeek request extension preparation failed`
 *      —— **伪装成 LLM provider 故障**，极难定位。见根 `package.json`。
 *   3. section 名不得撞社区插件（理由见 `LANGUAGE_SECTION` 的注释）。
 *
 * @param {object} ctx 插件级 ctx
 * @param {object} [options]
 * @param {() => string} [options.getPolicy]   读当前策略（默认恒为 `DEFAULT_LANGUAGE`）
 * @param {(level:string, message:string) => void} [options.log] 留痕
 * @returns {{available:() => boolean, current:() => (string|null), setPolicy:(p:string)=>boolean}}
 */
export function attachReasoningLanguage(ctx, options = {}) {
  const getPolicy = options.getPolicy ?? (() => DEFAULT_LANGUAGE)
  const log = options.log ?? (() => {})

  /** 作用域化的宿主 ctx（`systemPrompt` 挂在它上面）；服务不可用时恒为 null */
  let host = null
  /** 当前已注册 section 的撤销函数；null = 现在没有注册 */
  let disposeSection = null
  /** 最后一次**真的应用成功**的策略；`null` = 环境还没就绪 */
  let appliedPolicy = null
  /** 那个策略当时是否注册了 section。与 `appliedPolicy` 一起构成幂等判据 */
  let appliedRegistered = false

  const dropSection = () => {
    if (disposeSection === null) return
    try {
      disposeSection()
    } catch {
      /* 宿主可能已经先一步销毁了这个作用域 —— 那不是错误 */
    }
    disposeSection = null
  }

  const apply = (policy) => {
    if (host === null) return false
    const chosen = normalizePolicy(policy)
    const text = injectionText(chosen)
    const wantRegistered = text !== null

    // ⚠️ **幂等守卫**。实测：宿主对**一次**设置变更会回调我们 **4 次**
    //    （插件路由被注册了多份，于是 POST 落到多个 handler 上）。
    //    没有这道守卫的表现是 —— 日志里"已关闭（auto）"连打 4 条，
    //    且 section 被反复撤销/注册。策略与注册状态都没变就什么都不做。
    if (appliedPolicy === chosen && appliedRegistered === wantRegistered) return true

    // 先撤旧的再按新策略决定要不要注册：否则换语言会留下两条 section 同时在生效
    dropSection()
    appliedPolicy = chosen
    appliedRegistered = false

    if (!wantRegistered) {
      log('info', '已关闭（' + chosen + '）—— 系统提示保持原样')
      return true
    }
    try {
      const dispose = host.systemPrompt.section({
        name: LANGUAGE_SECTION, order: LANGUAGE_ORDER, text,
      })
      disposeSection = typeof dispose === 'function' ? dispose : null
      appliedRegistered = true
      log('info', '已开启（' + chosen + '）—— 本插件**修改了系统提示**，可在设置页关掉')
      return true
    } catch (error) {
      log('warn', '注册失败（' + chosen + '）：' + String(error && error.message))
      return false
    }
  }

  try {
    // 软探测：服务不在则回调不执行，桌宠/气泡/朗读不受任何影响
    ctx.inject(['systemPrompt'], (scoped) => {
      host = scoped
      // 宿主重建该作用域时把 section 一起撤掉，别留悬空注册
      scoped.effect(() => () => {
        dropSection()
        host = null
        // 作用域没了 ⇒ 之前记的状态一律作废，等下一次注入回调重建。
        // （少了这两行，上面的幂等守卫会在重建后误判"已经应用过"而跳过注册，
        //   表现是"插件重启后注入不生效"。）
        appliedPolicy = null
        appliedRegistered = false
      }, 'think-voice-pet: reasoning language')
      apply(getPolicy())
    })
  } catch (error) {
    log('warn', '探测 systemPrompt 服务失败：' + String(error && error.message))
  }

  return {
    /** 宿主是否提供了 systemPrompt 服务（没有 ⇒ 注入永远不生效，但插件可正常用） */
    available: () => host !== null,
    /** 当前生效的策略；环境未就绪时为 null */
    current: () => appliedPolicy,
    /** 设置变更时调用（R5 的一键关：传 `'auto'` 即撤销） */
    setPolicy: (policy) => apply(policy),
  }
}

/**
 * 订阅**思考**的两条通道，喂给应用层的 `thinking-pipeline`（DESIGN §6.1）。
 *
 * ⚠️ 这两个都是 **Scoped 事件**，必须带 `{ global: true }` 才会触发；
 *    不带的话订阅不报错、但**永远不回调** —— 这正是 P0-1 踩过的坑。
 *    这里兼容两种签名：带 `{global:true}` 抛错就退回默认签名，
 *    为的是在"有/没有该选项"的宿主版本上都能活。
 *
 * ⚠️ 回调里**绝不能把异常抛回宿主**：这是别人的事件流，一个异常会污染整条链
 *    （`attachActivityEvents` 里对 waterfall 事件的处理就是同一个道理）。
 *    所以每个 handler 都自己 try/catch，出错只留痕。
 *
 * @returns {{persistent:boolean, realtime:boolean}} 两条通道各自是否订阅成功
 */
export function attachThinkingEvents(ctx, pipeline) {
  const subscribe = (event, handler) => {
    const wrapped = (...args) => {
      try {
        return handler(...args)
      } catch (error) {
        logThinking('warn', event + ' 处理失败：' + String(error && error.message))
        return undefined
      }
    }
    try {
      ctx.on(event, wrapped, { global: true })
      return true
    } catch {
      try {
        ctx.on(event, wrapped)
        return true
      } catch {
        /* 宿主没有这个事件（旧版本）—— 不是错误，只是这条通道走不通 */
        return false
      }
    }
  }

  // 持久通道：`(session, event)` —— ⚠️ **两个位置参数**
  const persistent = subscribe('session/event', (_session, event) => {
    if (event?.type !== 'assistant/message') return
    pipeline.onSessionEvent(event)
  })

  // 实时通道：`({ agent, frame })` —— ⚠️ **一个对象参数**
  const realtime = subscribe('agent/assistant-stream', (payload) => {
    pipeline.onStreamFrame(payload)
  })

  logThinking('info', '思考通道订阅：持久=' + (persistent ? 'ok' : '不可用')
    + ' 实时=' + (realtime ? 'ok' : '不可用'))

  return { persistent, realtime }
}

/** The activity stream + snapshot route. */
function eventsRoute(hub) {  return {
    kind: 'exact',
    path: API + '/events',
    handler: (request, response) => {
      if (!loopbackOnly(request)) {
        response.writeHead(403)
        response.end()
        return
      }
      if (request.method !== 'GET' || hub === undefined) {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      const frame = (payload) => {
        // Guard every write: the peer may have gone away mid-push.
        try {
          response.write('data: ' + JSON.stringify(payload) + '\n\n')
        } catch {
          /* stream already closed */
        }
      }
      frame(hub.snapshot())
      const unsubscribe = hub.subscribe(frame)
      const ping = setInterval(() => {
        try {
          response.write(': ping\n\n')
        } catch {
          /* stream already closed */
        }
      }, SSE_PING_MS)
      ping.unref?.()
      const close = () => {
        clearInterval(ping)
        unsubscribe()
      }
      request.on('close', close)
      response.on('close', close)
      response.on('error', close)
    },
  }
}

/**
 * 显示层路由：桌宠在页面内还是桌面上。
 *
 * `GET` 给浏览器（它每秒问一次"现在该谁管这只宠物"），`POST` 给设置页（改偏好）。
 * **页面只读、不写** —— 判定与"拉起/收掉桌面端"都在宿主半区，两个写者会互相擦。
 */
function layerRoute(display) {
  return {
    kind: 'exact',
    path: API + '/layer',
    handler: async (request, response) => {
      if (!loopbackOnly(request)) {
        response.writeHead(403)
        response.end()
        return
      }
      if (request.method === 'POST') {
        let body = ''
        try {
          for await (const chunk of request) body += chunk
          const parsed = JSON.parse(body === '' ? '{}' : body)
          // `{action:"download-desktop"}`：把平台子包拉下来。**先回话、后台下** ——
          // 让这个请求等 5MB 下完的话，页面每秒的轮询会被堵住，观感是"卡住了"。
          if (parsed.action === 'download-desktop') {
            const started = display.startDownload()
            sendJson(response, 200, { ok: true, download: started, ...display.reconcile(), binary: display.binaryInfo() })
            return
          }
          display.setMode(parsed.mode)
        } catch {
          sendJson(response, 400, { ok: false, error: 'bad-body' })
          return
        }
      } else if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD, POST' })
        response.end()
        return
      }
      // 页面自己报来的地址就是 DSH 的地址（端口是配置的，猜会猜错）。
      //
      // ⚠️ 但**官方桌面客户端的页面 origin 是 `dsh-app://app`**（自定义协议）—— 那个值
      // 进不了 `setDshUrl`（它只收 `http(s)://`），于是会一直退回 3080 兜底：
      // 壳以挂载模式连上一个没人听的端口 ⇒ 桌面上什么都没有（用户 2026-09-30 报的
      // "插件里点桌面打开的 exe 显示不出宠物，直接双击倒是能出"就是这个）。
      // 所以**同时看 `Host` 头** —— 自定义协议下应用会把请求转给本地服务，Host 才是真的。
      const origin = request.headers?.origin
      if (typeof origin === 'string') display.setDshUrl(origin)
      const host = request.headers?.host
      if (typeof host === 'string' && /^[\w.\-]+(:\d+)?$/.test(host)) {
        display.setDshUrl('http://' + host)
      }
      // 每次读状态都顺手 reconcile 一次：设置页点完马上能看到结果，不用等下一个 tick。
      const status = display.reconcile()
      sendJson(response, 200, {
        ok: true,
        ...status,
        // 下载进度：设置页靠每秒的轮询把它显示出来。
        download: display.downloadState(),
        // 二进制在不在 —— 设置页那一行要如实告诉用户"下一句该干什么"。
        binary: display.binaryInfo(),
      })
    },
  }
}

/**
 * 共享设置路由（`GET|POST /api/think-voice-pet/settings`）。
 *
 * 为什么需要它：桌面端页面与 DSH 页面**不是同一个 origin**（壳有自己的随机端口），
 * localStorage 按 origin 隔离 ⇒ 两边各存一份、永不互见（用户报的"桌面的设置与 DSH 里的
 * 设置没有同步"）。所以设置要放到两端都能读的地方：`%DSH_HOME%\pet-settings.json`。
 *
 * 只同步三类**共享**项（tuning / overrides / outfit）；窗口自己的位置与大小不在这里。
 */
function settingsRoute(home, hooks = {}) {
  return {
    kind: 'exact',
    path: API + '/settings',
    handler: async (request, response) => {
      if (!loopbackOnly(request)) {
        response.writeHead(403)
        response.end()
        return
      }
      if (request.method === 'POST') {
        let body = ''
        try {
          for await (const chunk of request) body += chunk
          const parsed = JSON.parse(body === '' ? '{}' : body)
          const written = writeSettings(home, parsed)
          if (written === null) {
            sendJson(response, 500, { ok: false, error: 'write-failed' })
            return
          }
          // 写成功后**立刻**让宿主侧应用，不等重启 —— 这正是 R5「可一键关」的实现点：
          // 页面把 `speech.language` 改成 `'auto'`，注入当场被撤销。
          // 回调失败只留痕、不影响写入结果（设置已经落盘了，那是事实）。
          try {
            hooks.onSettingsWritten?.(written)
          } catch (error) {
            logThinking('warn', '设置变更回调失败：' + String(error && error.message))
          }
          sendJson(response, 200, { ok: true, ...written })
          return
        } catch {
          sendJson(response, 400, { ok: false, error: 'bad-body' })
          return
        }
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD, POST' })
        response.end()
        return
      }
      sendJson(response, 200, { ok: true, ...readSettings(home) })
    },
  }
}

// 回环地址仍可能被 DNS 重绑定命中：写入接口只认服务器实际监听端口的本机 Host。
function trustedSoundHost(request) {
  const port = request.socket?.localPort
  const host = request.headers.host?.toLowerCase()
  return Number.isInteger(port) && [
    `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`,
  ].includes(host)
}

// 音频接口的 pet id 必须来自当前目录；音频文件本身永不进入宠物目录。
function soundRoute(home) {
  return {
    kind: 'prefix',
    path: API + '/sound',
    handler: async (request, response) => {
      const fail = (status, error) => sendJson(response, status, { ok: false, error })
      if (!loopbackOnly(request)) return fail(403, 'forbidden')
      let parts
      try {
        parts = segmentsAfter(new URL(request.url ?? '/', 'http://pet.local').pathname, API + '/sound')?.map(decodeURIComponent)
      } catch { return fail(400, 'invalid-path') }
      if (!parts || (parts.length !== 1 && parts.length !== 2)
        || !/^[A-Za-z0-9_-]+$/.test(parts[0])
        || (parts.length === 2 && !SOUND_PHASES.includes(parts[1]))) return fail(404, 'not-found')
      const [id, phase] = parts
      if (!buildCatalog().some((pet) => pet.id === id)) return fail(404, 'not-found')
      if (request.method === 'POST') {
        if (phase === undefined) return fail(405, 'method-not-allowed')
        if (!trustedSoundHost(request)) return fail(403, 'untrusted-host')
        // 浏览器的跨站请求不能更改本地文件；代理端用自己的 Host 转发。
        const origin = request.headers.origin
        if (typeof origin === 'string' && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`) return fail(403, 'cross-origin')
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) return fail(415, 'json-required')
        let size = 0
        const chunks = []
        try {
          for await (const chunk of request) {
            size += chunk.length
            if (size > MAX_SOUND_BODY) return fail(413, 'body-too-large')
            chunks.push(chunk)
          }
        } catch { return fail(400, 'bad-body') }
        let parsed
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return fail(400, 'bad-body') }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail(400, 'bad-body')
        try {
          if (parsed.action === 'reset' && Object.keys(parsed).length === 1) resetSound(home, id, phase)
          else if (Object.keys(parsed).length === 1 && Object.hasOwn(parsed, 'base64')) {
            const bytes = decodeSound(parsed.base64)
            if (!bytes) return fail(400, 'invalid-audio')
            writeSound(home, id, phase, bytes)
          } else return fail(400, 'bad-body')
        } catch { return fail(500, 'write-failed') }
        return sendJson(response, 200, { ok: true })
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method-not-allowed')
      if (phase === undefined) {
        const sounds = {}
        for (const key of SOUND_PHASES) {
          const sound = readSound(home, id, key)
          if (sound) sounds[key] = {
            url: `${API}/sound/${encodeURIComponent(id)}/${key}?token=${sound.token}`,
            mime: sound.mime, bytes: sound.bytes.length, token: sound.token,
          }
        }
        return sendJson(response, 200, { ok: true, sounds })
      }
      const sound = readSound(home, id, phase)
      if (!sound) return fail(404, 'not-found')
      response.writeHead(200, {
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-type': sound.mime, 'content-length': String(sound.bytes.length),
      })
      response.end(request.method === 'HEAD' ? undefined : sound.bytes)
    },
  }
}

/**
 * 朗读音频路由（P3-2）。形状照 `soundRoute`，但有两处**必须**不同：
 *
 *   1. **要 token**。相位音效是可以公开的；朗读音频里是**用户的思考内容**，
 *      同机上的其它页面/程序不该能取到 ⇒ id 是内容哈希（猜不到）**不算**控制，
 *      真正的门是 `loopbackOnly` + `audio-cache` 的 token 校验。
 *   2. **`no-store`**。这类内容不该在浏览器缓存里留驻。
 */
function audioRoute(cache) {
  return {
    kind: 'prefix',
    path: API + '/audio',
    handler: (request, response) => {
      const fail = (status, error) => sendJson(response, status, { ok: false, error })
      if (!loopbackOnly(request)) return fail(403, 'forbidden')
      if (request.method !== 'GET' && request.method !== 'HEAD') return fail(405, 'method-not-allowed')
      let parts
      try {
        parts = segmentsAfter(new URL(request.url ?? '/', 'http://pet.local').pathname, API + '/audio')?.map(decodeURIComponent)
      } catch { return fail(400, 'invalid-path') }
      if (!parts || parts.length !== 1) return fail(404, 'not-found')
      const matched = /^([a-f0-9]{16})(?:\.mp3)?$/.exec(parts[0])
      if (!matched) return fail(404, 'not-found')
      let token = ''
      try {
        token = new URL(request.url ?? '/', 'http://pet.local').searchParams.get('token') ?? ''
      } catch { return fail(400, 'invalid-path') }
      const found = cache.get(matched[1], token)
      if (found === null) return fail(404, 'not-found')
      response.writeHead(200, {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-type': found.mime,
        'content-length': String(found.buffer.length),
      })
      response.end(request.method === 'HEAD' ? undefined : found.buffer)
    },
  }
}

/** The complete route table this plugin owns. */
export function buildRoutes(hub, display, home, hooks = {}) {
  const routes = [catalogRoute(), assetRoute(), runtimeRoute(), eventsRoute(hub)]
  if (display !== undefined) routes.push(layerRoute(display))
  // 共享设置：不依赖显示层（测试里也可能只给 home）。
  if (typeof home === 'string' && home !== '') routes.push(settingsRoute(home, hooks), soundRoute(home))
  // 朗读音频：缓存由 apply 持有；没有缓存（例如测试里只给一个 hub）就不挂这条路由。
  if (hooks.audioCache !== undefined) routes.push(audioRoute(hooks.audioCache))
  return routes
}

export function apply(ctx) {
  const hub = new ActivityHub()
  attachActivityEvents(ctx, hub)
  ctx.effect(() => () => hub.dispose(), 'think-voice-pet: activity hub')

  // ---- 思考语言注入（P3-0b；D10 的落地）----------------------------------------
  // 这是本插件唯一写用户环境的地方。策略取自共享设置 `speech.language`，
  // 默认中文（用户 2026-10-11 拍板）—— 因为 D10 已定"让思考变中文"，
  // 否则默认音色念英文会走音，主功能不成立。用户改成 'auto' 即当场撤销。
  const readPolicy = () => normalizePolicy(readSettings(dshHome()).speech?.language)
  const language = attachReasoningLanguage(ctx, {
    getPolicy: readPolicy,
    log: (level, message) => logThinking(level, '语言注入：' + message),
  })

  // 音色解析器。**有状态**是刻意的 —— 它要保证「一场对话里只出现一种音色」
  // （用户 2026-10-11 的要求：不要中途换音色）。
  //   · zh / en：压根不看文本，整场固定（Xiaoyi 中英都能念，实测可接受）
  //   · auto   ：按首句判定的语种锁定，之后粘滞
  // 详见 `lib/core/reasoning-language.js` 文件头。
  const voices = createVoiceResolver(readPolicy())

  // 显示层：每秒一次"按偏好把两边摆正"。桌面端的二进制由平台子包带下来
  // （`lib/desktop.js`），没有就只是提示，不影响页面内那只。
  const display = createDisplayLayer({
    home: dshHome(),
    hint: desktopHint({ home: dshHome() }),
    resolveBinary: () => resolveDesktopBinary({ home: dshHome() }),
    log: (message) => console.log('[think-voice-pet] ' + message),
  })
  // 宿主侧把它挂出来：设置路由与 `/api/think-voice-pet/layer` 共用同一个控制器。
  display.binaryInfo = () => {
    const found = resolveDesktopBinary({ home: dshHome() })
    return {
      found: found !== undefined,
      path: found?.path ?? null,
      source: found?.source ?? null,
      supported: desktopSupported(),
      hint: desktopHint({ home: dshHome() }),
    }
  }
  const tick = setInterval(() => {
    try {
      display.reconcile()
    } catch (error) {
      console.log('[think-voice-pet] 显示层 reconcile 失败：' + String(error && error.message))
    }
  }, 1000)
  tick.unref?.()
  ctx.effect(() => () => {
    clearInterval(tick)
    display.dispose()
  }, 'think-voice-pet: display layer')

  // ---- TTS（P3-1 / P3-2）--------------------------------------------------------
  // provider 是纯云端的 Edge：零显存、每次合成约 1.2s 墙钟（P0-2 实测）。
  // 缓存放内存（理由见 lib/infra/tts/audio-cache.js 的文件头），上限 8 条。
  const audioCache = createAudioCache()
  const tts = createTtsProvider('edge')
  ctx.effect(() => () => { void tts.dispose() }, 'think-voice-pet: tts provider')
  if (!tts.available()) {
    // R3：降级必须留痕。少了这一条，"没声音"会被当成 bug 反复排查。
    logThinking('warn', 'TTS 不可用（运行环境没有 WebSocket）→ 只显示气泡，不发声')
  }

  /**
   * 给一条待播帧补上音频 URL；**任何失败都退回原帧**
   * （`audioUrl: null` = 只显气泡，这是浏览器侧本来就容忍的降级形态）。
   *
   * ⚠️ 音色由 `voices`（有状态解析器）给，**整场恒定** ——
   *    不按每句的检测语种切换：那会让同一场对话里一会儿 Xiaoyi 一会儿 Ava，
   *    听起来像换了一个人。理由见 `lib/core/reasoning-language.js` 文件头。
   *    日志里带 voice 与 reason；`lang` 字段仍如实回报这一句实际是什么语种，
   *    那是用来判断「注入漂没漂」的，**不是**用来切音色的。
   */
  const withAudio = async (frame) => {
    if (!tts.available()) return frame
    const text = frame.payload.text
    const picked = voices.resolve(text)
    try {
      const audio = await tts.synthesize(text, { voice: picked.voice, pitch: picked.pitch })
      const entry = audioCache.put(audio, { mime: EDGE_MIME })
      logThinking('info', '合成：' + picked.voice + '（' + picked.reason + '）'
        + ' ' + audio.length + ' 字节' + (entry.cached ? '（缓存命中）' : ''))
      return {
        ...frame,
        payload: {
          ...frame.payload,
          audioUrl: API + '/audio/' + entry.id + '.mp3?token=' + entry.token,
        },
      }
    } catch (error) {
      logThinking('warn', '合成失败（' + picked.voice + ' / ' + picked.reason + '）'
        + '→ 本条只显示气泡：' + String(error && error.message))
      return frame
    }
  }

  // ---- 负载哨兵（P3-5；红线 R1 的第二道保险）--------------------------------------
  //
  // 与"不常驻模型权重"那道**结构性**保证互补：这里防的是**运行时**跟用户的主力负载抢机器。
  // 判定是纯逻辑（`lib/core/load-gate.js`，用假时钟就能单测），采样放这里做。
  // D7 默认：CPU ≥50% 或 GPU ≥50%，**持续** 10s ⇒ 静默；回落持续 10s ⇒ 恢复。
  const loadProbe = createLoadProbe()
  const loadGate = createLoadGate()
  /** D7 默认检测周期 */
  const LOAD_PROBE_MS = 10_000
  let gpuWarned = false

  const probeLoad = async () => {
    try {
      const sample = await loadProbe.read()
      // R3：GPU 这条线拿不到必须说出来 —— 不能让"只按 CPU 判定"悄悄发生
      if (!gpuWarned && !loadProbe.gpuAvailable()) {
        gpuWarned = true
        logThinking('info', '负载闸：本机没有 nvidia-smi，只按 CPU 判定（R3 降级留痕）')
      }
      const state = loadGate.judge(sample, Date.now())
      // 只在状态翻转时打日志：每 10s 一条"还是好好的"会把这行刷成噪音
      if (state.changed) {
        logThinking('info', '负载闸：'
          + (state.silent ? '**进入静默**（只显示气泡，不合成、不发声）' : '恢复朗读')
          + ' cpu=' + formatPercent(state.cpu) + ' gpu=' + formatPercent(state.gpu))
      }
    } catch (error) {
      // ⚠️ 采样失败**不进静默**：探针挂掉不该让宠物闭嘴。
      //    R1 的意图是"别抢资源"，不是"随时准备罢工"。
      logThinking('warn', '负载采样失败（本条忽略）：' + String(error && error.message))
    }
  }

  const loadTick = setInterval(() => { void probeLoad() }, LOAD_PROBE_MS)
  loadTick.unref?.()
  ctx.effect(() => () => { clearInterval(loadTick) }, 'think-voice-pet: load watcher')

  // ---- 朗读节奏（P4-5）--------------------------------------------------------
  //
  // planner **在这里建、在外面持有**（而不是让 `createThinkingPipeline` 自己造一个）：
  // 用户改间隔时要能拿到**同一个**实例换档。重建一个的代价不是性能，是**语义** ——
  // planner 持有待播队列与"念过什么"的记忆，重建等于随手把队列清了、刚念过的句子
  // 会被立刻再念一遍（"调个节奏把宠物弄结巴了"）。
  //
  // ⚠️ 必须声明在下面 `ctx.inject` **之前**：它已就绪时回调是**同步**执行的，
  //    而回调里的 `onSettingsWritten` 会访问 `speechPlanner` —— 声明在后面就撞 TDZ，
  //    而且这个错在"服务已就绪"与"服务后到"两种时序下表现还不一样，最难查。
  const clampSpeechInterval = (raw) => Math.min(
    SPEECH_INTERVAL_MAX_MS, Math.max(SPEECH_INTERVAL_MIN_MS, raw),
  )
  /**
   * 读用户设的朗读间隔（`speech.intervalMs`），缺省 = **D3 定稿的 20s**。
   *
   * 夹进 [MIN, MAX]：存档被人手改坏时不能让宠物要么一句话都念不出、要么刷屏。
   * 边界取自 `lib/core/speech-planner.js` 的常量对 —— 这里**不写死数字**，
   * 否则会立刻长出"滑杆允许 5s、宿主夹到 10s"式的双口径（用户看到"设了没用"）。
   */
  const readSpeechInterval = () => {
    const raw = readSettings(dshHome()).speech?.intervalMs
    return Number.isFinite(raw) ? clampSpeechInterval(raw) : SPEECH_INTERVAL_MS
  }
  const speechPlanner = createSpeechPlanner({ minIntervalMs: readSpeechInterval() })

  ctx.inject(['webServer'], (host) => {
    for (const route of buildRoutes(hub, display, dshHome(), {
      audioCache,
      // 设置一落盘就应用 —— 语言切换不必重启（R5「可一键关」）。
      onSettingsWritten: (settings) => {
        // 朗读节奏（P4-5）。**必须放在下面那个 `return` 之前** —— 改节奏时
        // `speech.language` 通常没动，早期返回会把它整段跳过（表现是"拖了滑杆没反应"）。
        const rawInterval = settings?.speech?.intervalMs
        if (Number.isFinite(rawInterval)) {
          const wanted = clampSpeechInterval(rawInterval)
          const applied = speechPlanner.setMinInterval(wanted)
          logThinking('info', '朗读间隔 → ' + wanted + 'ms' + (applied ? '（已生效）' : '（与现值相同，未变）'))
        }
        const policy = settings?.speech?.language
        if (typeof policy !== 'string') return
        language.setPolicy(policy)
        // 音色也要一起跟着走，否则会"改了语言、声音还是老那一套"（同属 R5）
        voices.setPolicy(policy)
      },
    })) {
      try {
        host.effect(() => host.webServer.register(route), 'think-voice-pet: route ' + route.path)
      } catch (error) {
        host.logger?.warn('think-voice-pet: route ' + route.path + ' failed: ' + String(error))
      }
    }
  })

  // ---- 思考流水线（P2-2 / P2-6 / P3-2）------------------------------------------
  //
  // 采集 → 切分 → 筛选 → 节流 → 合成 → 下发出 `speak` 帧（DESIGN §4.2 七步）。
  // 真正的编排在 `lib/app/thinking-pipeline.js`；这里只做"订阅 + 转发 + 定时问一声"。
  //
  // ⚠️ P3-2 起 `onSpeak` 里多了一步**异步合成**：先把音频备好，再一次性广播。
  //    为什么不等气泡先出、音频后补：那要么新增一种帧（改 DESIGN §6.4 的契约），
  //    要么让浏览器按文本去重（多一处容易出错的去重逻辑）。代价是气泡晚约 1.2s，
  //    换来"文字与声音同时出现"——宠物是"开口说这句话"，这本来就更自然。
  //    判据仍满足：出句 → 约 1.2s 合成 → 立即广播，远在 P3 出口的 3s 之内。
  let synthesizing = false

  const pipeline = createThinkingPipeline({
    // 用上面那个**外置**的 planner（P4-5 要能给它换档，见它的声明处）
    planner: speechPlanner,
    onSpeak: (frame, meta) => {
      // P2-2 的验收判据之一就是"host 日志出现思考片段"，所以这里**故意**打出片段
      const preview = frame.payload.text.length > 40
        ? frame.payload.text.slice(0, 40) + '…'
        : frame.payload.text
      logThinking('info', '朗读一条（score=' + String(meta?.score ?? '?')
        + ' 表情=' + String(frame.payload.emotion ?? '无') + '）：' + preview)

      // 负载闸（P3-5）：高负载时**只显示气泡**，不合成也不发声。
      // 放在最前面 —— 静默的意义就是"这会儿一点活都不干"（DESIGN §7.2）。
      if (loadGate.silent()) {
        logThinking('info', '负载高 → 本条只显示气泡（不合成、不发声）')
        hub.broadcast(frame)
        return
      }

      // 合成串行化：同一时刻只合成一条。20s 的频率闸（D3）远大于 1.2s 的合成，
      // 所以这条几乎不会触发；真触发了宁可"本条只显气泡"，也不要并发去打服务器。
      if (synthesizing) {
        logThinking('warn', '上一条仍在合成，本条先只显示气泡（不排队、不丢内容）')
        hub.broadcast(frame)
        return
      }
      synthesizing = true
      void withAudio(frame)
        .then((enriched) => hub.broadcast(enriched))
        .catch((error) => {
          // withAudio 内部已兜住 TTS 自身的失败；能落到这里的只有"我们自己写错了"
          logThinking('warn', '音频流程异常 → 本条只显示气泡：' + String(error && error.message))
          hub.broadcast(frame)
        })
        .finally(() => { synthesizing = false })
    },
    onLog: (entry) => {
      if (entry.level === 'debug') return
      logThinking(entry.level, '思考流水线：' + entry.detail)
    },
  })
  attachThinkingEvents(ctx, pipeline)

  // 每 2s 问一次"有没有该念的"。
  // ⚠️ 出句频率**不**由这个周期决定 —— 那是 lib/core/speech-planner 的 20s 频率闸（D3）。
  //    把闸放在领域层的好处正在于此：宿主问得多勤都不影响节奏。
  const speechTick = setInterval(() => {
    try {
      pipeline.tick()
    } catch (error) {
      logThinking('warn', '流水线 tick 失败：' + String(error && error.message))
    }
  }, 2000)
  speechTick.unref?.()
  ctx.effect(() => () => {
    clearInterval(speechTick)
    pipeline.reset()
  }, 'think-voice-pet: thinking pipeline')
}
