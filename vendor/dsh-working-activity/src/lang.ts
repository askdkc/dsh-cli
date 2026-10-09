/**
 * Language resolution + copy dictionary for the working-activity plugin.
 *
 * The plugin follows the dsh-cli UI language without importing it: the same
 * chain dsh-cli resolves (`DSH_CLI_LANG` env → `~/.dsh-cli/lang.json` → OS
 * locale → en) is read here directly, so a `/lang en|zh` switch (or the
 * /settings language pick) hot-swaps rendered status-line copy. Model-facing
 * narration instructions are locale-independent.
 *
 * Resolution order:
 *   1. `setLangOverride()` — a plugin-level `lang: zh|en` config key
 *      (cordis.yml) or an explicit test pin.
 *   2. `DSH_CLI_LANG` env var — pinned at process start.
 *   3. `~/.dsh-cli/lang.json` — the persisted dsh-cli choice, mtime-cached
 *      so the per-tick status render never re-reads an unchanged file.
 *   4. OS locale guess (`LC_ALL` / `LC_MESSAGES` / `LANG`); POSIX/C means
 *      "no locale selected" and maps to English.
 *   5. `en` — the fallback for unsupported or absent locales.
 *
 * The dictionary is a flat key → per-language string map; `t(key, params)`
 * substitutes `{{name}}` placeholders. Missing keys render the key itself so
 * a typo is visible instead of silently blank.
 * @module @deepseek-ai/dsh-working-activity/lang
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'

export type Lang = 'zh' | 'en' | 'ja'

/** The languages shipped with the plugin, in display order. */
export const LANGS = ['zh', 'en', 'ja'] as const

const progressLanguage = new AsyncLocalStorage<Lang>()

/** Scope a rendered status line to its own session without changing the UI language. */
export function withProgressLang<T>(lang: Lang, render: () => T): T {
  return progressLanguage.run(lang, render)
}

/** Use the terminal locale only for the first ambiguous prompt in a session. */
export function terminalProgressLang(): Lang {
  const locale = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '').toLowerCase()
  if (locale.startsWith('ja')) return 'ja'
  if (locale.startsWith('zh')) return 'zh'
  return 'en'
}

/** Detect only confident language signals in user-authored prose. */
export function detectInputLanguage(input: string): Lang | undefined {
  const prose = input.normalize('NFKC')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/\b(?:https?|file):\/\/\S+/gi, ' ')
    .replace(/(?:^|\s)(?:[A-Za-z]:\\|\/|\.\.?\/)[^\s]+/g, ' ')
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(prose)) return 'ja'
  const han = prose.match(/\p{Script=Han}/gu)?.length ?? 0
  const latin = prose.match(/[A-Za-z]/g)?.length ?? 0
  if (han >= 4 && han > latin) return 'zh'
  if ((prose.match(/\b[A-Za-z]+(?:'[A-Za-z]+)?\b/g)?.length ?? 0) >= 3) return 'en'
  return undefined
}

/** The dsh-cli prefs file this plugin mirrors (shared language contract). */
const LANG_FILE = join(homedir(), '.dsh-cli', 'lang.json')

/** Model instructions never inherit the interface or terminal language. */
export const NARRATE_INSTRUCTION = '[Status line] You have a status line visible to the user. [Required] At the start of each step or subtask (not only before tool calls), write exactly one standalone line at the very beginning of your response: ⏵ a concrete description of what you are doing (20 words max), then continue with the normal response on the next line. Write only one ⏵ line per response and do not repeat it. Prioritize information so the user can understand the current work at a glance; keep the style natural and optionally playful. Examples: ⏵ Fixing the login page styles, ⏵ Investigating the error, ⏵ Running validation for the patch. Update it when the task changes. Write the status description in the same response language chosen for the user request; use English when unclear.'

const dict = {
  // Retain the existing translation key without localizing model instructions.
  'narrate-instruction': { zh: NARRATE_INSTRUCTION, en: NARRATE_INSTRUCTION },
  // ── status-line structural copy ─────────────────────────────────────
  /** Plain (non-playful) phase labels. */
  'waiting-label': { zh: '等待模型响应', en: 'Waiting for model', ja: 'モデルの応答待ち' },
  'thinking-label': { zh: '思考中', en: 'Thinking', ja: '考えています' },
  /** Elapsed suffix: zh glues the char, en keeps a space. */
  'line-elapsed': { zh: '总{{elapsed}}', en: 'total {{elapsed}}', ja: '合計 {{elapsed}}' },
  /** Plain-mode completion prefix (playful pools pick their own). */
  'done-prefix': { zh: '搞定 ✓', en: 'Finished', ja: '完了 ✓' },
  /** Turn-completion summary. */
  'done-summary': {
    zh: '{{tools}} · 想{{thinking}} 干{{tooling}}',
    en: '{{tools}} · thought {{thinking}} worked {{tooling}}',
    ja: '{{tools}} · 思考 {{thinking}} 作業 {{tooling}}',
  },
  'tool-count-one': { zh: '{{count}} 工具', en: '{{count}} tool', ja: 'ツール {{count}} 件' },
  'tool-count-many': { zh: '{{count}} 工具', en: '{{count}} tools', ja: 'ツール {{count}} 件' },
  /** Consecutive-tool streak badge (replaces the old flame emoji). */
  'tool-streak': { zh: '工具x{{count}}', en: 'tool x{{count}}', ja: 'ツール連続 {{count}} 件' },
  /** Approval badge while a tool is parked on the user's decision. */
  'tool-waiting-approval': { zh: '在等你批准', en: 'awaiting your approval', ja: '承認待ち' },
  /** Subagent count in the done summary. */
  'subagent-count': { zh: '子代理 {{count}} 个', en: '{{count}} subagents', ja: 'サブエージェント {{count}} 件' },
  /** Work-reminder copy after `workRemindAt` turn-hours. */
  'work-remind': { zh: '已连续工作 {{hours}} 小时，歇会儿？', en: 'Worked {{hours}}h straight — take a break?', ja: '{{hours}} 時間続けて作業しています。少し休みますか？' },
} as const

export type I18nKey = keyof typeof dict
export type I18nParams = Record<string, string | number>

/** Explicit pin set by plugin config or tests; `auto` restores the chain. */
let override: Lang | 'auto' = 'auto'

/** Force (or release) the active language; `auto` re-enables the chain. */
export function setLangOverride(lang: Lang | 'auto'): void {
  override = lang
  // Releasing (or re-setting) the pin decides the language from the file again,
  // and an explicit switch must not wait out the probe TTL.
  invalidateLangCache()
}

/** The currently active language. */
export function langNow(): Lang {
  const scoped = progressLanguage.getStore()
  if (scoped !== undefined) return scoped
  if (override !== 'auto') return override
  const env = process.env.DSH_CLI_LANG
  if (env === 'zh' || env === 'en') return env
  return readLangFile() ?? detectLocaleLang()
}

/** Translate a dictionary key, substituting `{{name}}` placeholders. */
export function t(key: I18nKey, params: I18nParams = {}): string {
  const entry = dict[key] as { zh: string; en: string; ja?: string } | undefined
  const template = entry?.[langNow()] ?? entry?.en ?? key
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}

/** Is a value a valid shipped language code? */
export function isLang(value: unknown): value is Lang {
  return value === 'zh' || value === 'en' || value === 'ja'
}

/**
 * How long one filesystem probe is trusted. Long enough that a 500 ms status
 * render does not stat the file on every translation, short enough that a
 * `/lang` switch written by the UI still lands within a second.
 */
const LANG_FILE_PROBE_TTL_MS = 1000

/**
 * Read the persisted dsh-cli language choice.
 *
 * The probe is cached twice over: the parsed value is reused while the file's
 * mtime is unchanged, and even the `statSync` itself is skipped for
 * {@link LANG_FILE_PROBE_TTL_MS}. Both halves matter — one render translates
 * several keys, and a host that never wrote the file would otherwise pay a
 * FAILED stat on every one of them (issue #14).
 *
 * @param nowMs - Instant to measure the probe cache against.
 * @returns the persisted language, or `undefined` when the file is absent or
 * holds no valid `{ lang }` value.
 */
export function readLangFile(nowMs: number = Date.now()): Lang | undefined {
  if (lastProbeAt !== 0 && nowMs - lastProbeAt < LANG_FILE_PROBE_TTL_MS) return cachedLang
  lastProbeAt = nowMs
  let mtimeMs: number
  try {
    mtimeMs = statSync(LANG_FILE).mtimeMs
  } catch {
    // Absence is cached like any other answer: the common case on a host that
    // never ran the UI's language picker.
    cachedMtime = -1
    cachedLang = undefined
    return undefined
  }
  if (cachedMtime === mtimeMs) return cachedLang
  try {
    const parsed: unknown = JSON.parse(readFileSync(LANG_FILE, 'utf8'))
    const lang = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).lang
      : undefined
    cachedLang = isLang(lang) ? lang : undefined
  } catch {
    cachedLang = undefined
  }
  cachedMtime = mtimeMs
  return cachedLang
}

/**
 * Drop the file cache so the next read probes the filesystem immediately.
 * Called whenever the language is pinned explicitly, so a switch is never
 * delayed by the probe TTL.
 */
export function invalidateLangCache(): void {
  lastProbeAt = 0
  cachedMtime = -1
  cachedLang = undefined
}

let cachedMtime = -1
let cachedLang: Lang | undefined
/** When the file was last probed; `0` means "never probed in this process". */
let lastProbeAt = 0

/**
 * Guess the language from the OS locale (`LC_ALL`, `LC_MESSAGES`, `LANG`),
 * defaulting to `en`. POSIX/C means "no locale selected" and conventionally
 * maps to English (what CI runners report). An absent locale variable
 * (typical on Windows) defaults to `en`.
 */
export function detectLocaleLang(): Lang {
  const raw =
    process.env.LC_ALL ||
    process.env.LC_MESSAGES ||
    process.env.LANG ||
    ''
  const locale = raw.split('.')[0]?.toLowerCase() ?? ''
  if (locale.startsWith('zh')) return 'zh'
  if (locale.startsWith('en')) return 'en'
  if (locale === 'c' || locale === 'posix') return 'en'
  return 'en'
}
