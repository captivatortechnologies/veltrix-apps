import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// Qualys asset-group business impact levels (the API `business_impact` param).
// The empty value means "leave unset" — the UI's "Not set" option.
export const BUSINESS_IMPACT_VALUES = ['', 'critical', 'high', 'medium', 'low', 'minimal'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface AssetGroupSpec {
  sectionName: string
  title: string
  comments: string
  division: string
  location: string
  businessImpact: string
  ips: string
  networkId: string
}

/** Shape of an asset group parsed from a GET /asset/group/ (action=list) block. */
export interface LiveAssetGroup {
  id: string
  title: string
  comments: string
  businessImpact: string
  networkId: string
  ips: string[]
}

/** The title natural key — an asset group's logical identity (title-keyed collection). */
export function assetGroupKey(spec: { title: string }): string {
  return spec.title.trim().toLowerCase()
}

function readNumericField(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return value.trim()
  return ''
}

/** Each canvas item describes one Qualys asset group. */
export function extractAssetGroupSpecs(canvas: CanvasSnapshot): AssetGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      title: typeof fields.title === 'string' ? fields.title.trim() : '',
      comments: typeof fields.comments === 'string' ? fields.comments.trim() : '',
      division: typeof fields.division === 'string' ? fields.division.trim() : '',
      location: typeof fields.location === 'string' ? fields.location.trim() : '',
      businessImpact: typeof fields.business_impact === 'string' ? fields.business_impact.trim() : '',
      ips: typeof fields.ips === 'string' ? fields.ips.trim() : '',
      networkId: readNumericField(fields.network_id),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate asset group configurations: a title is required and unique (Qualys
 * requires a unique title and forbids "All"), the business impact is from the
 * supported set, and an optional network id must be a positive integer.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAssetGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.title) {
      errors.push({ field: `${prefix}.title`, message: 'Asset group title is required', code: 'required' })
    } else if (spec.title.toLowerCase() === 'all') {
      errors.push({
        field: `${prefix}.title`,
        message: 'Asset group title cannot be "All" (reserved by Qualys)',
        code: 'reserved_title',
      })
    }

    if (spec.businessImpact && !BUSINESS_IMPACT_VALUES.includes(spec.businessImpact as (typeof BUSINESS_IMPACT_VALUES)[number])) {
      errors.push({
        field: `${prefix}.business_impact`,
        message: `Unsupported business impact "${spec.businessImpact}"`,
        code: 'invalid_value',
      })
    }

    if (spec.networkId && !/^\d+$/.test(spec.networkId)) {
      errors.push({
        field: `${prefix}.network_id`,
        message: 'Network ID must be a positive integer (only for subscriptions with Network Support)',
        code: 'invalid_network_id',
      })
    }

    if (spec.title) {
      const key = assetGroupKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.title`,
          message: `Duplicate asset group "${spec.title}" — each title may only be declared once`,
          code: 'duplicate_asset_group',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
