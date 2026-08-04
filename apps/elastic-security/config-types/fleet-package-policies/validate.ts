import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Kibana Fleet Package Policies API constraints ---------------------------

export const MAX_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface FleetPackagePolicySpec {
  sectionName: string
  /** Policy name — Fleet assigns the internal id, so this app reconciles by name. */
  name: string
  description?: string
  namespace: string
  enabled: boolean
  /** Target Fleet agent policy id(s). */
  policyIds: string[]
  packageName: string
  packageVersion: string
  packageTitle?: string
  /** Raw JSON-array string of NewPackagePolicyInput objects. Required. */
  inputsJson?: string
  /** Raw JSON-object string of top-level package vars; absent = none. */
  varsJson?: string
}

/** The fields of a live Fleet package policy this app authors/diffs (subset of Fleet's PackagePolicy type). */
export interface LiveFleetPackagePolicy {
  id: string
  name?: string
  description?: string
  namespace?: string
  enabled?: boolean
  policy_ids?: string[]
  package?: { name?: string; title?: string; version?: string }
  inputs?: unknown[]
  vars?: Record<string, unknown>
  updated_at?: string
  updated_by?: string
}

/** GET /api/fleet/package_policies list envelope — `{ items, total, page, perPage }`. */
export interface LiveFleetPackagePolicyList {
  items?: LiveFleetPackagePolicy[]
}

/** Split a `tags` field (array, or comma/newline string) into trimmed, non-empty strings. */
export function splitList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** Parse a raw JSON string, returning the array or null when it is not a JSON array. */
export function parseJsonArray(raw: string): unknown[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return Array.isArray(parsed) ? parsed : null
}

/** Parse a raw JSON string, returning the object or null when it is not a JSON object. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return null
}

/** Each canvas section describes one Fleet package policy. */
export function extractPolicySpecs(canvas: CanvasSnapshot): FleetPackagePolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const trimmed = (key: string): string | undefined =>
      typeof fields[key] === 'string' && (fields[key] as string).trim() ? (fields[key] as string).trim() : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: trimmed('description'),
      namespace: trimmed('namespace') ?? 'default',
      enabled: fields.enabled !== false,
      policyIds: splitList(fields.policyIds),
      packageName: typeof fields.packageName === 'string' ? fields.packageName.trim() : '',
      packageVersion: typeof fields.packageVersion === 'string' ? fields.packageVersion.trim() : '',
      packageTitle: trimmed('packageTitle'),
      inputsJson: trimmed('inputsJson'),
      varsJson: trimmed('varsJson'),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Fleet package-policy configurations against the Fleet API's
 * NewPackagePolicy shape. Static rules only — NO network:
 *   - name is required, capped, and the logical identity this app reconciles
 *     on (unique per canvas)
 *   - at least one Agent Policy ID is required
 *   - packageName + packageVersion are required
 *   - inputsJson is required and must parse to a JSON ARRAY; varsJson, when
 *     present, must parse to a JSON object
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPolicySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required', code: 'required' })
    } else if (spec.name.length > MAX_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `Policy name must be ${MAX_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    if (spec.policyIds.length === 0) {
      errors.push({
        field: `${prefix}.policyIds`,
        message: 'At least one Agent Policy ID is required — this integration must be attached to an agent policy',
        code: 'required',
      })
    }

    if (!spec.packageName) {
      errors.push({ field: `${prefix}.packageName`, message: 'Package Name is required', code: 'required' })
    }
    if (!spec.packageVersion) {
      errors.push({ field: `${prefix}.packageVersion`, message: 'Package Version is required', code: 'required' })
    }

    if (!spec.inputsJson) {
      errors.push({
        field: `${prefix}.inputsJson`,
        message: 'Inputs is required — provide a JSON array, e.g. [{"type":"endpoint","enabled":true,"streams":[]}]',
        code: 'required',
      })
    } else if (parseJsonArray(spec.inputsJson) === null) {
      errors.push({
        field: `${prefix}.inputsJson`,
        message: 'Inputs must be a valid JSON array of input objects',
        code: 'invalid_inputs',
      })
    }

    if (spec.varsJson && parseJsonObject(spec.varsJson) === null) {
      errors.push({
        field: `${prefix}.varsJson`,
        message: 'Top-level Vars must be a valid JSON object — leave blank for none',
        code: 'invalid_vars',
      })
    }

    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate policy "${spec.name}" — each policy name may only be declared once per canvas`,
          code: 'duplicate_policy',
        })
      }
      seenNames.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
