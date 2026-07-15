import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cloudflare Lists constraints ---------------------------------------------

/** The supported list kinds; fixed at creation and drives each item's body shape. */
export const LIST_KINDS = ['ip', 'hostname', 'asn', 'redirect'] as const
export type ListKind = (typeof LIST_KINDS)[number]

/** A list name is a slug: lowercase letters, digits and underscores only. */
export const LIST_NAME_PATTERN = /^[a-z0-9_]+$/
/** Cloudflare caps list names at 50 characters. */
export const MAX_NAME_LENGTH = 50

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ListSpec {
  sectionName: string
  name: string
  kind: string
  description: string
  /** One value per line; the desired contents, replaced wholesale on deploy. */
  items: string[]
}

/** Shape of a list returned by GET /rules/lists. */
export interface LiveList {
  id?: string
  name?: string
  kind?: string
  description?: string
  /** Cloudflare reports the current item count on the list object. */
  num_items?: number
}

/** Shape of a list item returned by GET /rules/lists/{id}/items. */
export interface LiveListItem {
  id?: string
  ip?: string
  hostname?: string
  asn?: string | number
  redirect?: string
}

/** Split a textarea value into trimmed, non-empty lines. */
export function parseItems(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** The API body for a single list item, keyed by the list's kind. */
export function buildItemBody(kind: string, value: string): Record<string, unknown> {
  switch (kind) {
    case 'hostname':
      return { hostname: value }
    case 'asn':
      return { asn: value }
    case 'redirect':
      return { redirect: value }
    case 'ip':
    default:
      return { ip: value }
  }
}

/** Pull the scalar value back out of a live list item, keyed by the list's kind. */
export function extractItemValue(kind: string, item: LiveListItem): string | null {
  switch (kind) {
    case 'hostname':
      return typeof item.hostname === 'string' ? item.hostname : null
    case 'asn':
      return item.asn !== undefined && item.asn !== null ? String(item.asn) : null
    case 'redirect':
      return typeof item.redirect === 'string' ? item.redirect : null
    case 'ip':
    default:
      return typeof item.ip === 'string' ? item.ip : null
  }
}

/** Each canvas item describes one Cloudflare List. */
export function extractListSpecs(canvas: CanvasSnapshot): ListSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const rawKind = typeof fields.kind === 'string' ? fields.kind.trim() : ''
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      kind: rawKind || 'ip',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      items: parseItems(fields.items),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Cloudflare List configurations: a name is required and must be a
 * lowercase slug (^[a-z0-9_]+$, ≤50 chars), unique across the canvas; the kind
 * must be one of ip / hostname / asn / redirect.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractListSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'List name is required', code: 'required' })
    } else if (!LIST_NAME_PATTERN.test(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Invalid list name "${spec.name}" — use lowercase letters, digits and underscores only (^[a-z0-9_]+$)`,
        code: 'invalid_name',
      })
    } else if (spec.name.length > MAX_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `List name "${spec.name}" is too long — Cloudflare allows at most ${MAX_NAME_LENGTH} characters`,
        code: 'invalid_name',
      })
    } else {
      if (seen.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate list name "${spec.name}" — each list must be uniquely named`,
          code: 'duplicate_list',
        })
      }
      seen.add(spec.name)
    }

    if (!LIST_KINDS.includes(spec.kind as ListKind)) {
      errors.push({ field: `${prefix}.kind`, message: `Unsupported list kind "${spec.kind}"`, code: 'invalid_kind' })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
