import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// Jamf Pro Departments — modern API (GET/POST/PUT/DELETE /v1/departments).
// https://developer.jamf.com/jamf-pro/reference/get_v1-departments — the
// simplest object in the API: just `name` (1-225 chars). Referenced by name
// from scoping fields on other config types (e.g. restricted-software).

export interface DepartmentSpec {
  sectionName: string
  name: string
}

export interface LiveDepartment {
  id?: string
  name?: string
}

export function departmentKey(name: string): string {
  return name.trim().toLowerCase()
}

export function indexDepartmentsByName(departments: LiveDepartment[]): Map<string, LiveDepartment> {
  const byName = new Map<string, LiveDepartment>()
  for (const d of departments) {
    if (!d.name) continue
    const key = departmentKey(d.name)
    if (!byName.has(key)) byName.set(key, d)
  }
  return byName
}

export function extractDepartmentSpecs(canvas: CanvasSnapshot): DepartmentSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return { sectionName: section.name, name: str(fields.name) }
  })
}

export function buildDepartmentBody(spec: DepartmentSpec): Record<string, unknown> {
  return { name: spec.name }
}

/** Validate department configurations: name required, unique (case-insensitive), 1-225 chars per the Department schema. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractDepartmentSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Department name is required', code: 'required' })
    } else if (spec.name.length > 225) {
      errors.push({ field: `${prefix}.name`, message: 'Department name must be 225 characters or fewer', code: 'too_long' })
    }

    if (spec.name) {
      const key = departmentKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate department "${spec.name}" — each name may only be declared once in this canvas`,
          code: 'duplicate_department',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
