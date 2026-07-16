import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Wiz service-account constraints -----------------------------------------

/**
 * Service-account types accepted by `CreateServiceAccountInput.type`. The
 * custom-integration API account is THIRD_PARTY; the others cover Wiz sensors
 * and connectors. (FIRST_PARTY is Wiz-internal and intentionally excluded.)
 */
export const SERVICE_ACCOUNT_TYPES = [
  'THIRD_PARTY',
  'SENSOR',
  'KUBERNETES_ADMISSION_CONTROLLER',
  'BROKER',
  'KUBERNETES_CONNECTOR',
] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ServiceAccountSpec {
  sectionName: string
  name: string
  type: string
  scopes: string[]
  assignedProjectIds: string[]
}

/** Shape of a service account returned by the `serviceAccounts` list query. */
export interface LiveServiceAccount {
  id?: string
  name?: string
  type?: string
  scopes?: string[]
  clientId?: string
}

/**
 * The account's logical identity: its name. Case-insensitive and trimmed so a
 * re-typed name with different casing/whitespace reconciles to the same account
 * both across the canvas (dedupe) and against the live tenant (list-match).
 */
export function accountKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Read a canvas value that may be a `tags` array, a single string, or a comma list. */
export function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** Case-insensitive set-equality for two scope/id lists. */
export function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a.map((s) => s.toLowerCase()))
  return b.every((s) => setA.has(s.toLowerCase()))
}

/** Each canvas item describes one Wiz service account. */
export function extractServiceAccountSpecs(canvas: CanvasSnapshot): ServiceAccountSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      sectionName: section.name,
      name: str(fields.name),
      type: str(fields.type) || 'THIRD_PARTY',
      scopes: strList(fields.scopes),
      assignedProjectIds: strList(fields.assigned_project_ids),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Wiz service-account configurations: a name is required and unique
 * across the canvas (case-insensitive); the type must be a supported value; and
 * a THIRD_PARTY (custom-integration API) account must declare at least one scope.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractServiceAccountSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Service account name is required', code: 'required' })
    }

    if (!SERVICE_ACCOUNT_TYPES.includes(spec.type as (typeof SERVICE_ACCOUNT_TYPES)[number])) {
      errors.push({
        field: `${prefix}.type`,
        message: `Unsupported service account type "${spec.type}"`,
        code: 'invalid_type',
      })
    }

    if (spec.type === 'THIRD_PARTY' && spec.scopes.length === 0) {
      errors.push({
        field: `${prefix}.scopes`,
        message: 'A custom-integration (THIRD_PARTY) service account must declare at least one API scope',
        code: 'required',
      })
    }

    if (spec.scopes.some((s) => s.length === 0)) {
      errors.push({ field: `${prefix}.scopes`, message: 'Scopes must not contain empty values', code: 'invalid_scope' })
    }

    if (spec.name) {
      const key = accountKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate service account "${spec.name}" — each name may only be declared once`,
          code: 'duplicate_account',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
