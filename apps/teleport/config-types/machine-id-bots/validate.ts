import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

export const BOT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/
export const DURATION_PATTERN = /^[0-9]+(h|m|s)$/

/**
 * Normalize a duration string to total seconds, for comparing this app's
 * single-unit input format (e.g. "12h") against whatever format Teleport's
 * protobuf-JSON echoes back for `spec.max_session_ttl` (a `google.protobuf.Duration`
 * canonically renders as a possibly-fractional seconds count with an "s"
 * suffix, e.g. "43200s" — not independently verified against a live cluster,
 * so both this app's own format and that canonical form are accepted).
 * Returns null when the string matches neither shape.
 */
export function durationToSeconds(value: string): number | null {
  const trimmed = value.trim()
  const protoSeconds = /^(-?\d+(?:\.\d+)?)s$/.exec(trimmed)
  if (protoSeconds) return parseFloat(protoSeconds[1])

  const goDuration = /^(\d+)(h|m|s)$/.exec(trimmed)
  if (goDuration) {
    const amount = parseInt(goDuration[1], 10)
    const unit = goDuration[2]
    return unit === 'h' ? amount * 3600 : unit === 'm' ? amount * 60 : amount
  }
  return null
}

export interface BotTrait {
  name: string
  values: string[]
}

export interface BotSpec {
  sectionName: string
  botName: string
  description: string | null
  roles: string[]
  traits: BotTrait[]
  maxSessionTtl: string | null
}

/** Split a `keyvalue` field's `{name: "v1,v2"}` shape into `[{name, values: [...]}]`. */
export function traitsFromKeyValue(raw: unknown): BotTrait[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const traits: BotTrait[] = []
  for (const [name, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    if (!name.trim()) continue
    const values =
      typeof rawValue === 'string'
        ? rawValue
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
        : []
    traits.push({ name: name.trim(), values })
  }
  return traits
}

/** Each canvas item describes one Machine ID bot. */
export function extractBotSpecs(canvas: CanvasSnapshot): BotSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const botName = typeof fields.botName === 'string' ? fields.botName.trim() : ''
    const description = typeof fields.description === 'string' && fields.description.trim() ? fields.description.trim() : null
    const roles = Array.isArray(fields.roles) ? fields.roles.filter((r): r is string => typeof r === 'string' && r.trim().length > 0).map((r) => r.trim()) : []
    const traits = traitsFromKeyValue(fields.traits)
    const maxSessionTtl =
      typeof fields.maxSessionTtl === 'string' && fields.maxSessionTtl.trim() ? fields.maxSessionTtl.trim() : null
    return { sectionName: section.name, botName, description, roles, traits, maxSessionTtl }
  })
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractBotSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.botName) {
      errors.push({ field: `${prefix}.botName`, message: 'Bot name is required', code: 'required' })
    } else {
      if (!BOT_NAME_PATTERN.test(spec.botName)) {
        errors.push({
          field: `${prefix}.botName`,
          message: 'Bot name may only contain letters, numbers, dots, underscores and hyphens',
          code: 'invalid_name',
        })
      }
      if (seenNames.has(spec.botName)) {
        errors.push({
          field: `${prefix}.botName`,
          message: `Duplicate bot "${spec.botName}" — each bot name may only be declared once per canvas`,
          code: 'duplicate_bot',
        })
      }
      seenNames.add(spec.botName)
    }

    if (spec.roles.length === 0) {
      errors.push({ field: `${prefix}.roles`, message: 'At least one role is required', code: 'required' })
    }

    if (spec.maxSessionTtl && !DURATION_PATTERN.test(spec.maxSessionTtl)) {
      errors.push({
        field: `${prefix}.maxSessionTtl`,
        message: 'Max session TTL must be a duration like "12h", "30m" or "3600s"',
        code: 'invalid_duration',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
