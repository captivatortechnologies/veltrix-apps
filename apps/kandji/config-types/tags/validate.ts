import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// Kandji Tags — https://api-docs.iru.com (Kandji's own API reference):
//   GET    /api/v1/tags?search=...   — list / search (search is optional; omitted returns every tag)
//   POST   /api/v1/tags               — create (Body: raw JSON, {"name": "..."}). "Can only create one tag per request."
//   PATCH  /api/v1/tags/{tag_id}      — update tag name
//   DELETE /api/v1/tags/{tag_id}      — delete

export interface TagSpec {
  sectionName: string
  name: string
}

export interface LiveTag {
  id?: string
  name?: string
}

export function tagKey(name: string): string {
  return name.trim().toLowerCase()
}

export function indexTagsByName(tags: LiveTag[]): Map<string, LiveTag> {
  const byName = new Map<string, LiveTag>()
  for (const tag of tags) {
    if (!tag.name) continue
    const key = tagKey(tag.name)
    if (!byName.has(key)) byName.set(key, tag)
  }
  return byName
}

export function extractTagSpecs(canvas: CanvasSnapshot): TagSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return { sectionName: section.name, name: str(fields.name) }
  })
}

export function buildTagBody(spec: TagSpec): Record<string, unknown> {
  return { name: spec.name }
}

/** Validate tag configurations: name required and unique (case-insensitive). */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractTagSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Tag name is required', code: 'required' })
    }

    if (spec.name) {
      const key = tagKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate tag "${spec.name}" — each name may only be declared once in this canvas`,
          code: 'duplicate_tag',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
