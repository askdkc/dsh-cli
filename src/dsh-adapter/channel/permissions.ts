import { type SessionModeSpec } from '../../sessionModes.js'
import { cleanRenderText } from '../sanitize.js'
import type { PermissionPresetOption, PermissionPresetService, PermissionPresetSnapshot } from './types.js'

export const PERMISSION_PRESET_CUSTOM = 'custom'

export const PERMISSION_PRESET_NAME_CELLS = 120

export const PERMISSION_PRESET_DESCRIPTION_CELLS = 400

/** The mounted registry may expose seams this package's declared contract
 *  does not name yet: `resolve` (atom bundles) and `set` (the write path the
 *  official `/permission` command drives). Read structurally, never assumed. */
export interface PermissionPresetRuntime extends PermissionPresetService {
  resolve?: (name: string) => unknown
  set?: (subject: unknown, name: string) => unknown
}

/** One runtime preset's resolved atom bundle. */
export interface PermissionPresetBundle {
  readonly value: string
  readonly sandbox?: SessionModeSpec['sandbox']
  readonly approval?: SessionModeSpec['approval']
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/** Narrow a raw service read to the structural registry surface. */
export function permissionPresetRuntime(service: unknown): PermissionPresetRuntime | undefined {
  return isRecord(service) ? service as PermissionPresetRuntime : undefined
}

/** Keep a permission roster read-only after it crosses the adapter boundary.
 *  The registry may reuse and mutate its option objects between reads; callers
 *  must observe one stable snapshot instead of a live view into that service. */
export function freezePermissionPresetSnapshot(snapshot: PermissionPresetSnapshot): PermissionPresetSnapshot {
  const options = Object.freeze(snapshot.options.map(option => Object.freeze({ ...option })))
  const current = snapshot.current === undefined ? undefined : Object.freeze({ ...snapshot.current })
  return Object.freeze({
    availability: snapshot.availability,
    options,
    ...(current === undefined ? {} : { current }),
  })
}

export function unavailablePermissionPresetSnapshot(): PermissionPresetSnapshot {
  return freezePermissionPresetSnapshot({ availability: 'unavailable', options: [] })
}

export function normalizePermissionPresetOption(value: unknown): PermissionPresetOption | undefined {
  if (!isRecord(value) || typeof value.value !== 'string' || typeof value.name !== 'string') return undefined
  const name = cleanRenderText(value.name, PERMISSION_PRESET_NAME_CELLS)
  if (name === '') return undefined
  if (value.description !== undefined && typeof value.description !== 'string') return undefined
  const description = value.description === undefined
    ? undefined
    : cleanRenderText(value.description, PERMISSION_PRESET_DESCRIPTION_CELLS)
  if (value.description !== undefined && description === '') return undefined
  return {
    value: value.value,
    name,
    ...(description === undefined || description === '' ? {} : { description }),
  }
}

/** Atom bundles the deployment's preset table resolves (value →
 *  sandbox/approval). Empty when the service is absent or exposes no
 *  `resolve` seam — canonical resolution then falls back to the stock
 *  bundles (see `canonicalPresetFor`). */
export function permissionBundlesFromService(service: unknown): readonly PermissionPresetBundle[] {
  const runtime = permissionPresetRuntime(service)
  if (runtime === undefined || typeof runtime.resolve !== 'function') return []
  const names: readonly unknown[] = Array.isArray(runtime.names) ? runtime.names : []
  const bundles: PermissionPresetBundle[] = []
  for (const name of names) {
    if (typeof name !== 'string') continue
    try {
      // The registry resolves atoms on instance state; never detach `resolve`.
      const spec = runtime.resolve(name)
      if (!isRecord(spec)) continue
      const sandbox = spec.sandbox
      const approval = spec.approval
      if (
        (sandbox === 'read-only' || sandbox === 'workspace-write' || sandbox === 'danger-full-access')
        && (approval === 'ask' || approval === 'never')
      ) {
        bundles.push({ value: name, sandbox, approval })
      }
    } catch {
      // Optional resolution; a broken entry just does not extend the table.
    }
  }
  return bundles
}

/** Read the current registry's Session-based projection. */
export function permissionPresetSnapshotFromService(
  service: unknown,
  subject: unknown,
): PermissionPresetSnapshot {
  const runtime = permissionPresetRuntime(service)
  if (runtime === undefined) return unavailablePermissionPresetSnapshot()
  try {
    const capturedNames: readonly unknown[] = Array.isArray(runtime.names) ? runtime.names : []
    if (capturedNames.length === 0) return unavailablePermissionPresetSnapshot()
    if (typeof runtime.current !== 'function' || typeof runtime.optionOf !== 'function') {
      return unavailablePermissionPresetSnapshot()
    }
    // Readback lives on the registry instance; bind so the calls below keep
    // reaching it through the same object instead of a detached reference.
    const current = runtime.current.bind(runtime) as (subject: unknown) => unknown
    const optionOf = runtime.optionOf.bind(runtime)

    const names: string[] = []
    for (const name of capturedNames) {
      if (typeof name !== 'string' || name.trim() === '' || name === PERMISSION_PRESET_CUSTOM || names.includes(name)) {
        return unavailablePermissionPresetSnapshot()
      }
      names.push(name)
    }
    const seen = new Set(names)

    const options: PermissionPresetOption[] = []
    for (const name of names) {
      const option = normalizePermissionPresetOption(optionOf(name))
      if (option === undefined || option.value !== name) return unavailablePermissionPresetSnapshot()
      options.push({ ...option })
    }

    const currentValue = current(subject)
    if (typeof currentValue !== 'string' || (currentValue !== PERMISSION_PRESET_CUSTOM && !seen.has(currentValue))) {
      return unavailablePermissionPresetSnapshot()
    }
    const currentOption = normalizePermissionPresetOption(optionOf(currentValue))
    if (currentOption === undefined || currentOption.value !== currentValue) return unavailablePermissionPresetSnapshot()
    if (currentValue !== PERMISSION_PRESET_CUSTOM) {
      const rosterOption = options.find(option => option.value === currentValue)
      if (
        rosterOption === undefined
        || rosterOption.name !== currentOption.name
        || rosterOption.description !== currentOption.description
      ) {
        return unavailablePermissionPresetSnapshot()
      }
    }

    return freezePermissionPresetSnapshot({
      availability: 'runtime',
      options,
      current: {
        ...currentOption,
        kind: currentValue === PERMISSION_PRESET_CUSTOM ? 'custom' : 'preset',
      },
    })
  } catch {
    return unavailablePermissionPresetSnapshot()
  }
}
