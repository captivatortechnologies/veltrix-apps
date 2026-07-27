import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Certification Campaign Template constraints -----------------
// This manages the declarative template (and could manage its schedule); it does
// NOT generate campaign runs. The embedded `campaign` object is a validated JSON
// blob normalized by ISC on save, so drift tracks the scalar fields only.

export const MAX_NAME_LENGTH = 128

export interface CampaignTemplateSpec {
  itemId?: string
  name: string
  description: string
  /** ISO-8601 duration, e.g. "P2W". */
  deadlineDuration: string
  /** raw JSON for the embedded `campaign` definition. */
  campaignRaw: string
}

/** A campaign template as returned by GET /v3/campaign-templates. */
export interface LiveCampaignTemplate {
  id?: string
  name?: string
  description?: string | null
  deadlineDuration?: string | null
  campaign?: Record<string, unknown>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function parseJsonObject(
  raw: string
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw) return { ok: true, value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'must be a JSON object' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

export function extractCampaignTemplateSpecs(canvas: CanvasSnapshot): CampaignTemplateSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      deadlineDuration: asString(f.deadlineDuration),
      campaignRaw:
        typeof f.campaign === 'string'
          ? f.campaign.trim()
          : f.campaign && typeof f.campaign === 'object'
            ? JSON.stringify(f.campaign)
            : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractCampaignTemplateSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate campaign template "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.description) {
      errors.push({ field: `${prefix}.description`, message: 'A description is required', code: 'required' })
    }

    const parsed = parseJsonObject(spec.campaignRaw)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.campaign`, message: `Campaign must be a JSON object: ${parsed.error}`, code: 'invalid_campaign' })
    } else if (!spec.campaignRaw) {
      errors.push({ field: `${prefix}.campaign`, message: 'An embedded campaign definition is required', code: 'required' })
    } else if (!asString((parsed.value as { type?: unknown }).type)) {
      errors.push({ field: `${prefix}.campaign`, message: 'The campaign definition must declare a "type" (MANAGER, SOURCE_OWNER, SEARCH or ROLE_COMPOSITION)', code: 'invalid_campaign' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
