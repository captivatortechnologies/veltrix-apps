import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface SearchListSpec {
  sectionName: string
  title: string
  qids: string
  global: boolean
  comments: string
}

/** Shape of a static search list parsed from a list response block. */
export interface LiveSearchList {
  id: string
  title: string
  global: boolean
  qids: string[]
  comments: string
}

export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1' || value === 1) return true
  if (value === 'false' || value === '0' || value === 0) return false
  return fallback
}

/** The title natural key — a search list's logical identity (title-keyed collection). */
export function searchListKey(spec: { title: string }): string {
  return spec.title.trim().toLowerCase()
}

/** Normalize a comma/whitespace-separated QID list into a de-duplicated array. */
export function parseQids(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of raw.split(/[\s,]+/)) {
    const q = token.trim()
    if (!q || seen.has(q)) continue
    seen.add(q)
    out.push(q)
  }
  return out
}

/** Each canvas item describes one Qualys static search list. */
export function extractSearchListSpecs(canvas: CanvasSnapshot): SearchListSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      title: typeof fields.title === 'string' ? fields.title.trim() : '',
      qids: typeof fields.qids === 'string' ? fields.qids.trim() : '',
      global: readBool(fields.global, false),
      comments: typeof fields.comments === 'string' ? fields.comments.trim() : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate static search list configurations: a title is required and unique,
 * and the QID list is required and must contain only numeric QIDs.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSearchListSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.title) {
      errors.push({ field: `${prefix}.title`, message: 'Search list title is required', code: 'required' })
    }

    const qids = parseQids(spec.qids)
    if (qids.length === 0) {
      errors.push({ field: `${prefix}.qids`, message: 'At least one QID is required', code: 'required' })
    } else {
      const bad = qids.filter((q) => !/^\d+$/.test(q))
      if (bad.length > 0) {
        errors.push({
          field: `${prefix}.qids`,
          message: `QIDs must be numbers — invalid: ${bad.join(', ')}`,
          code: 'invalid_qid',
        })
      }
    }

    if (spec.title) {
      const key = searchListKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.title`,
          message: `Duplicate search list "${spec.title}" — each title may only be declared once`,
          code: 'duplicate_search_list',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
