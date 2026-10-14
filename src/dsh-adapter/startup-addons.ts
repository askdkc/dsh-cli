import type { Context, Fiber } from '@deepseek-ai/cordis'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/cordis-plugin-loader'

interface StartupEntry {
  id: string
  disabled: boolean
  options: { name: string; config?: { enabled?: unknown } }
  fiber?: Fiber
  refresh(): Promise<void>
}

interface StartupLoader {
  entries(): Iterable<StartupEntry>
}

// Cordis publishes FiberState as a const enum, without a runtime export.
const PENDING = 0, ACTIVE = 2, FAILED = 3

/** A child provider becomes visible while the frontend itself is still loading.
 * A service constructed directly on that loading fiber cannot satisfy an addon
 * which the frontend is about to await. The child retains frontend ownership. */
export async function ensureCliUserQuestions(ctx: Context): Promise<UserQuestionService> {
  if (ctx.get('userQuestions') === undefined) await ctx.plugin(UserQuestionService)
  return ctx.get('userQuestions')!
}

/**
 * The configured Kiokuko entry must finish mounting commands and tool hooks
 * before the first interactive input. This is a one-shot integration contract:
 * unrelated Loader work and later addon reloads do not own the frontend.
 *
 * The profile's include patches have already expanded before its CLI row runs.
 * No configured entry (including a bare host) means there is nothing to await.
 * Fiber.await() alone is insufficient: it also resolves for PENDING fibers.
 * Public lifecycle events cover pending dependencies and fiber replacement;
 * Entry.refresh() joins an import which has not created its fiber yet.
 * Returns false when this frontend is disposed while waiting.
 */
export async function awaitConfiguredKiokukoStartup(ctx: Context, timeoutMs = 30_000): Promise<boolean> {
  const loader = ctx.get('loader') as StartupLoader | undefined
  if (typeof loader?.entries !== 'function') return true
  const configured = (): StartupEntry[] => [...loader.entries()].filter(entry =>
    entry.options.name === 'kiokuko-dsh' && !entry.disabled && entry.options.config?.enabled !== false)
  if (!configured().length) return true

  return new Promise<boolean>((resolve, reject) => {
    let finished = false
    let queued = false
    const importing = new Set<StartupEntry>()
    const disposers: Array<() => unknown> = []
    const finish = (ready: boolean, error?: Error): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      const errors: unknown[] = error ? [error] : []
      // Registration and teardown can themselves fail. Drain every already
      // installed listener and timer before rejecting the startup boundary.
      for (const dispose of disposers.splice(0).reverse()) {
        try { dispose() } catch (cleanupError) { errors.push(cleanupError) }
      }
      if (errors.length === 1) reject(errors[0])
      else if (errors.length > 1) reject(new AggregateError(errors, 'Kiokuko startup cleanup failed'))
      else resolve(ready)
    }
    const failed = (entry: StartupEntry, reason: string, cause?: unknown): void => {
      finish(false, new Error(`kiokuko-dsh startup failed (${entry.id}): ${reason}`, { cause }))
    }
    const schedule = (): void => {
      if (queued || finished) return
      queued = true
      // Loader assigns a replacement fiber after its creation event returns.
      queueMicrotask(() => {
        queued = false
        if (finished) return
        try {
          // Disposal publishes uid=null before waiting for an in-flight apply.
          // Waiting for this fiber's effect cleanup would deadlock that apply.
          if (ctx.fiber.uid === null) return finish(false)
          const entries = configured()
          for (const entry of entries) {
            if (!entry.fiber) {
              if (!importing.has(entry)) {
                importing.add(entry)
                void entry.refresh().then(() => {
                  importing.delete(entry)
                  if (!configured().includes(entry)) return schedule()
                  if (!entry.fiber) failed(entry, 'the configured plugin could not be imported; see the Loader error above')
                  else schedule()
                }, error => {
                  importing.delete(entry)
                  if (!configured().includes(entry)) return schedule()
                  failed(entry, 'the configured plugin could not be imported', error)
                })
              }
              continue
            }
            if (entry.fiber.state === FAILED) {
              const fiber = entry.fiber
              void fiber.await().catch(error => {
                if (configured().includes(entry) && entry.fiber === fiber && fiber.state === FAILED) {
                  failed(entry, error instanceof Error ? error.message : String(error), error)
                } else schedule()
              })
              return
            }
          }
          if (entries.every(entry => entry.fiber?.state === ACTIVE)) finish(true)
        } catch (error) {
          finish(false, error instanceof Error ? error : new Error(String(error)))
        }
      })
    }
    const timer = setTimeout(() => {
      const pending = configured().map(entry => `${entry.id} (${entry.fiber?.state === PENDING ? 'waiting for required services' : 'activation incomplete'})`).join(', ')
      finish(false, new Error(`kiokuko-dsh startup timed out after ${timeoutMs}ms: ${pending}. Check its Loader dependencies and startup log.`))
    }, timeoutMs)
    try {
      disposers.push(ctx.on('internal/status', schedule, { global: true }))
      disposers.push(ctx.on('internal/plugin', schedule, { global: true }))
      disposers.push(ctx.on('loader/partial-dispose', schedule, { global: true }))
      disposers.push(ctx.on('loader/config-update', schedule, { global: true }))
      disposers.push(ctx.effect(() => () => finish(false)))
      schedule()
    } catch (error) {
      finish(false, error instanceof Error ? error : new Error(String(error)))
    }
  })
}
