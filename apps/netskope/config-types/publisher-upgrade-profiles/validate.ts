import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Netskope NPA publisher upgrade profile constraints ----------------------

export const RELEASE_TYPES = ['Beta', 'Latest', 'Latest-1', 'Latest-2'] as const
export type ReleaseType = (typeof RELEASE_TYPES)[number]

export interface UpgradeProfileSpec {
  itemId?: string
  /** name — the logical identity (profiles are id-addressed; the app matches on
   *  name and stores the external_id for rename-safety). */
  name: string
  dockerTag: string
  releaseType: string
  enabled: boolean
  /** 5-field CRON expression, e.g. "0 0 1 * TUE". */
  frequency: string
  timezone: string
  /** Optional timezone id; 0 means "not set" and is omitted from the body. */
  timezoneId: number
}

/** An upgrade profile as returned by GET /api/v2/infrastructure/publisherupgradeprofiles. */
export interface LiveUpgradeProfile {
  external_id?: number | string
  publisher_upgrade_profile_id?: number | string
  id?: number | string
  name?: string
  docker_tag?: string
  release_type?: string
  enabled?: boolean
  frequency?: string
  timezone?: string
  timezone_id?: number
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function asNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const n = Number(asString(v))
  return Number.isFinite(n) && asString(v) !== '' ? n : fallback
}

export function liveUpgradeProfileId(l: LiveUpgradeProfile): string | undefined {
  const v = l.external_id ?? l.publisher_upgrade_profile_id ?? l.id
  return v === undefined || v === null ? undefined : String(v)
}

export function extractUpgradeProfileSpecs(canvas: CanvasSnapshot): UpgradeProfileSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      dockerTag: asString(f.docker_tag),
      releaseType: asString(f.release_type) || 'Latest',
      enabled: f.enabled !== false,
      frequency: asString(f.frequency),
      timezone: asString(f.timezone),
      timezoneId: asNumber(f.timezone_id, 0),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractUpgradeProfileSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate upgrade profile "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.dockerTag) {
      errors.push({ field: `${prefix}.docker_tag`, message: 'Docker tag is required (from the publishers releases list)', code: 'required' })
    }

    if (!RELEASE_TYPES.includes(spec.releaseType as ReleaseType)) {
      errors.push({ field: `${prefix}.release_type`, message: `Release type must be one of ${RELEASE_TYPES.join(', ')}`, code: 'invalid_release_type' })
    }

    if (!spec.frequency) {
      errors.push({ field: `${prefix}.frequency`, message: 'Frequency (5-field CRON) is required', code: 'required' })
    } else if (spec.frequency.split(/\s+/).filter(Boolean).length !== 5) {
      errors.push({ field: `${prefix}.frequency`, message: 'Frequency must be a 5-field CRON expression, e.g. "0 0 1 * TUE"', code: 'invalid_cron' })
    }

    if (!spec.timezone) {
      errors.push({ field: `${prefix}.timezone`, message: 'Timezone is required, e.g. US/Eastern', code: 'required' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
