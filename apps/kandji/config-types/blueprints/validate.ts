import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// Kandji Blueprints — the tenant's core device-assignment construct.
// https://api-docs.iru.com (Kandji's own API reference; the vendor rebranded
// to "Iru" but the docs banner confirms api.kandji.io hostnames/routes are
// unchanged for existing tenants):
//   GET    /api/v1/blueprints                 — list (id/id__in/name/limit/offset filters)
//   GET    /api/v1/blueprints/:blueprint_id    — get
//   POST   /api/v1/blueprints                  — create (Body: urlencoded)
//   PATCH  /api/v1/blueprints/:blueprint_id    — update (Body: urlencoded)
//   DELETE /api/v1/blueprints/:blueprint_id    — delete (destructive — un-manages every assigned device)

export const BLUEPRINT_TYPES = ['classic', 'map'] as const
export type BlueprintType = (typeof BLUEPRINT_TYPES)[number]

export interface BlueprintSpec {
  sectionName: string
  name: string
  description: string
  type: string
  icon: string
  color: string
  enrollmentActive: boolean
  enrollmentCode: string
}

/** Shape of a Kandji Blueprint object, as returned by list/get/create/update. */
export interface LiveBlueprint {
  id?: string
  name?: string
  description?: string
  icon?: string
  color?: string
  type?: string
  enrollment_code?: { code?: string; is_active?: boolean }
  computers_count?: number
}

/** The Blueprint's logical identity: its name (case-insensitive, trimmed). */
export function blueprintKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Build a name → live-Blueprint map, case-insensitive, first match wins. */
export function indexBlueprintsByName(blueprints: LiveBlueprint[]): Map<string, LiveBlueprint> {
  const byName = new Map<string, LiveBlueprint>()
  for (const bp of blueprints) {
    if (!bp.name) continue
    const key = blueprintKey(bp.name)
    if (!byName.has(key)) byName.set(key, bp)
  }
  return byName
}

/** Each canvas item describes one Kandji Blueprint. */
export function extractBlueprintSpecs(canvas: CanvasSnapshot): BlueprintSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    const bool = (value: unknown, fallback: boolean): boolean =>
      typeof value === 'boolean' ? value : fallback
    return {
      sectionName: section.name,
      name: str(fields.name),
      description: str(fields.description),
      type: str(fields.type) || 'classic',
      icon: str(fields.icon),
      color: str(fields.color),
      enrollmentActive: bool(fields.enrollment_active, true),
      enrollmentCode: str(fields.enrollment_code),
    }
  })
}

/** The urlencoded body for POST /api/v1/blueprints (create). `type` is create-only. */
export function buildBlueprintCreateBody(spec: BlueprintSpec): Record<string, string> {
  const body: Record<string, string> = {
    name: spec.name,
    type: spec.type,
    'enrollment_code.is_active': String(spec.enrollmentActive),
  }
  if (spec.description) body.description = spec.description
  if (spec.icon) body.icon = spec.icon
  if (spec.color) body.color = spec.color
  if (spec.enrollmentCode) body['enrollment_code.code'] = spec.enrollmentCode
  return body
}

/**
 * The urlencoded body for PATCH /api/v1/blueprints/{id} (update). `type` is
 * omitted — Kandji does not support changing an existing Blueprint's type.
 */
export function buildBlueprintUpdateBody(spec: BlueprintSpec): Record<string, string> {
  const body: Record<string, string> = {
    name: spec.name,
    description: spec.description,
    'enrollment_code.is_active': String(spec.enrollmentActive),
  }
  if (spec.icon) body.icon = spec.icon
  if (spec.color) body.color = spec.color
  if (spec.enrollmentCode) body['enrollment_code.code'] = spec.enrollmentCode
  return body
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractBlueprintSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Blueprint name is required', code: 'required' })
    }

    if (!BLUEPRINT_TYPES.includes(spec.type as BlueprintType)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Blueprint type must be one of ${BLUEPRINT_TYPES.join(', ')} (got "${spec.type}")`,
        code: 'invalid_type',
      })
    }

    if (spec.type === 'map' && (spec.icon || spec.color)) {
      warnings.push({
        field: `${prefix}.icon`,
        message: 'Icon and color are ignored by Kandji for the Assignment Map Blueprint type',
        code: 'ignored_for_map',
      })
    }

    if (spec.name) {
      const key = blueprintKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate Blueprint "${spec.name}" — each name may only be declared once in this canvas`,
          code: 'duplicate_blueprint',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
