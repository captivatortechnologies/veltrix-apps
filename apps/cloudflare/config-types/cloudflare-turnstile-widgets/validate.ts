import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cloudflare Turnstile widgets ----------------------------------------------
//
// A Turnstile widget is Cloudflare's CAPTCHA replacement: embed its `sitekey` in
// a form and verify the returned token server-side with its `secret`. A widget
// is account-scoped (/accounts/{account_id}/challenges/widgets); Cloudflare
// assigns the sitekey, so identity for reconciliation is the widget `name` —
// Cloudflare's own docs note the name is "not unique," but this app, like every
// other Access/Gateway type here, treats it as the logical identity for
// matching and enforces uniqueness across the canvas.
//
// ⚠ SECURITY: `secret` is write-only (Cloudflare marks it `x-sensitive` and
// redacts it on read except immediately after creation/rotation). This app
// never reads it back, never diffs it, and never stores it in rollback data,
// artifacts or logs — only the sitekey (needed to address the widget) is kept.

export const TURNSTILE_MODES = ['managed', 'non-interactive', 'invisible'] as const
export const TURNSTILE_REGIONS = ['world', 'china'] as const
export const TURNSTILE_CLEARANCE_LEVELS = ['no_clearance', 'jschallenge', 'managed', 'interactive'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface TurnstileWidgetSpec {
  sectionName: string
  name: string
  mode: string
  /** One hostname/IP per line. */
  domains: string[]
  botFightMode: boolean
  region: string
  offlabel: boolean
  ephemeralId: boolean
  clearanceLevel: string
}

/** Shape of a widget returned by GET /challenges/widgets (secret redacted except right after create/rotate). */
export interface LiveTurnstileWidget {
  sitekey?: string
  name?: string
  mode?: string
  domains?: string[]
  bot_fight_mode?: boolean
  region?: string
  offlabel?: boolean
  ephemeral_id?: boolean
  clearance_level?: string
}

/** Split a textarea value into trimmed, non-empty lines. */
export function parseDomains(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** The reconciliation key for a widget — its name, case-folded. */
export function widgetKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Each canvas item describes one Cloudflare Turnstile widget. */
export function extractTurnstileWidgetSpecs(canvas: CanvasSnapshot): TurnstileWidgetSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      mode: typeof fields.mode === 'string' && fields.mode.trim() ? fields.mode.trim() : 'managed',
      domains: parseDomains(fields.domains),
      botFightMode: fields.bot_fight_mode === true,
      region: typeof fields.region === 'string' && fields.region.trim() ? fields.region.trim() : 'world',
      offlabel: fields.offlabel === true,
      ephemeralId: fields.ephemeral_id === true,
      clearanceLevel:
        typeof fields.clearance_level === 'string' && fields.clearance_level.trim()
          ? fields.clearance_level.trim()
          : 'no_clearance',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Turnstile widget configurations: a name is required and unique
 * across the canvas (its identity), mode/region/clearance_level must be one of
 * their supported values, and at least one domain is required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractTurnstileWidgetSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Widget name is required', code: 'required' })
    } else {
      const key = widgetKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate widget name "${spec.name}" — Veltrix reconciles by name, so each declared widget must be uniquely named`,
          code: 'duplicate_widget',
        })
      }
      seen.add(key)
    }

    if (!TURNSTILE_MODES.includes(spec.mode as (typeof TURNSTILE_MODES)[number])) {
      errors.push({ field: `${prefix}.mode`, message: `Unsupported mode "${spec.mode}"`, code: 'invalid_mode' })
    }

    if (spec.domains.length === 0) {
      errors.push({ field: `${prefix}.domains`, message: 'At least one domain is required', code: 'required' })
    }

    if (!TURNSTILE_REGIONS.includes(spec.region as (typeof TURNSTILE_REGIONS)[number])) {
      errors.push({ field: `${prefix}.region`, message: `Unsupported region "${spec.region}"`, code: 'invalid_region' })
    }

    if (!TURNSTILE_CLEARANCE_LEVELS.includes(spec.clearanceLevel as (typeof TURNSTILE_CLEARANCE_LEVELS)[number])) {
      errors.push({
        field: `${prefix}.clearance_level`,
        message: `Unsupported clearance level "${spec.clearanceLevel}"`,
        code: 'invalid_clearance_level',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
