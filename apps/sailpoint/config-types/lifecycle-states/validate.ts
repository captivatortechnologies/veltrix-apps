import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Lifecycle State constraints -------------------------------
// A lifecycle state is a nested child of an identity profile, keyed within its
// parent by `technicalName`. The parent profile is resolved by name → id first.

export const MAX_NAME_LENGTH = 128

export interface LifecycleStateSpec {
  itemId?: string
  /** name of the parent identity profile (resolved to an id at deploy time). */
  profileName: string
  name: string
  /** technicalName — the stable key within the parent profile. */
  technicalName: string
  description: string
  enabled: boolean
  /** ids of access profiles granted while in this state. */
  accessProfileIds: string[]
  /** raw JSON for the `accountActions` array ([{action, sourceIds}]). */
  accountActionsRaw: string
  identityState: string
}

/** A lifecycle state as returned by GET .../lifecycle-states. */
export interface LiveLifecycleState {
  id?: string
  name?: string
  technicalName?: string
  description?: string | null
  enabled?: boolean
  accessProfileIds?: string[]
  accountActions?: Array<Record<string, unknown>>
  identityState?: string | null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

function toIdList(v: unknown): string[] {
  const raw = Array.isArray(v)
    ? v.map((x) => String(x).trim())
    : typeof v === 'string'
      ? v.split(/[,\n]/).map((s) => s.trim())
      : []
  return [...new Set(raw.filter((s) => s.length > 0))]
}

export function parseJsonArray(
  raw: string
): { ok: true; value: unknown[] } | { ok: false; error: string } {
  if (!raw) return { ok: true, value: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' }
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'must be a JSON array' }
  return { ok: true, value: parsed }
}

export function extractLifecycleStateSpecs(canvas: CanvasSnapshot): LifecycleStateSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      profileName: asString(f.profileName),
      name: asString(f.name) || item.name,
      technicalName: asString(f.technicalName),
      description: asString(f.description),
      enabled: asBool(f.enabled),
      accessProfileIds: toIdList(f.accessProfileIds),
      accountActionsRaw:
        typeof f.accountActions === 'string'
          ? f.accountActions.trim()
          : Array.isArray(f.accountActions)
            ? JSON.stringify(f.accountActions)
            : '',
      identityState: asString(f.identityState),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractLifecycleStateSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.profileName) {
      errors.push({ field: `${prefix}.profileName`, message: 'A parent identity profile name is required', code: 'required' })
    }
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    }
    if (!spec.technicalName) {
      errors.push({ field: `${prefix}.technicalName`, message: 'Technical name is required', code: 'required' })
    } else if (spec.technicalName.length > MAX_NAME_LENGTH) {
      errors.push({ field: `${prefix}.technicalName`, message: `Technical name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
    }

    if (spec.profileName && spec.technicalName) {
      const key = `${spec.profileName.toLowerCase()}::${spec.technicalName.toLowerCase()}`
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.technicalName`, message: `Duplicate lifecycle state "${spec.technicalName}" for profile "${spec.profileName}"`, code: 'duplicate_name' })
      }
      seen.add(key)
    }

    const parsed = parseJsonArray(spec.accountActionsRaw)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.accountActions`, message: `Account actions must be a JSON array: ${parsed.error}`, code: 'invalid_actions' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
