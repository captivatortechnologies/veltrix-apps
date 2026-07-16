import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/** InsightVM site importance levels — multiply the risk score of a site's assets. */
export const SITE_IMPORTANCE = ['very_low', 'low', 'normal', 'high', 'very_high'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface SiteSpec {
  sectionName: string
  name: string
  description: string
  importance: string
  /** Optional scan engine id — omitted from the request body when unset. */
  engineId?: number
  /** Optional scan template id (a string id) — omitted from the body when blank. */
  scanTemplateId: string
  /** Included scan targets (hostnames / IPs / CIDRs), one per line. */
  includedAddresses: string[]
  /** Excluded scan targets, one per line. */
  excludedAddresses: string[]
}

/** Shape of a site returned by GET /sites (the HAL summary resource). */
export interface LiveSite {
  id?: number
  name?: string
  description?: string
  importance?: string
}

/**
 * A site's logical identity — its name. Normalised to lower-case so reconciliation
 * matches the console regardless of the casing declared on the canvas.
 */
export function siteKey(spec: { name: string }): string {
  return spec.name.trim().toLowerCase()
}

/** Split a textarea into trimmed, non-empty lines (one target/CIDR per line). */
export function parseLines(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/** Each canvas item describes one InsightVM scan site. */
export function extractSiteSpecs(canvas: CanvasSnapshot): SiteSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const importance =
      typeof fields.importance === 'string' && fields.importance.trim() ? fields.importance.trim() : 'normal'
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      importance,
      engineId: readNumber(fields.engine_id),
      scanTemplateId: typeof fields.scan_template_id === 'string' ? fields.scan_template_id.trim() : '',
      includedAddresses: parseLines(typeof fields.included_addresses === 'string' ? fields.included_addresses : ''),
      excludedAddresses: parseLines(typeof fields.excluded_addresses === 'string' ? fields.excluded_addresses : ''),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate site configurations: a name and at least one included target are
 * required, the importance is from the supported set, and the site name (its
 * natural key) is unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSiteSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Site name is required', code: 'required' })
    }
    if (spec.includedAddresses.length === 0) {
      errors.push({
        field: `${prefix}.included_addresses`,
        message: 'At least one included address (hostname, IP or CIDR) is required',
        code: 'required',
      })
    }
    if (!SITE_IMPORTANCE.includes(spec.importance as (typeof SITE_IMPORTANCE)[number])) {
      errors.push({ field: `${prefix}.importance`, message: `Unsupported importance "${spec.importance}"`, code: 'invalid_importance' })
    }

    if (spec.name) {
      const key = siteKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate site "${spec.name}" — each site name may only be declared once`,
          code: 'duplicate_site',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
