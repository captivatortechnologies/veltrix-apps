import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Managed Cluster (VA cluster) constraints ------------------
// Declarative cluster definition. The virtual appliance still needs manual
// bootstrap; this owns the cluster record only.

export const MAX_NAME_LENGTH = 128

export interface ManagedClusterSpec {
  itemId?: string
  name: string
  type: string
  description: string
  /** raw JSON for the cluster `configuration` object. */
  configurationRaw: string
}

/** A managed cluster as returned by GET /v3/managed-clusters. */
export interface LiveManagedCluster {
  id?: string
  name?: string
  type?: string
  description?: string | null
  configuration?: Record<string, unknown>
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

export function extractManagedClusterSpecs(canvas: CanvasSnapshot): ManagedClusterSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      type: asString(f.type) || 'sailpoint',
      description: asString(f.description),
      configurationRaw:
        typeof f.configuration === 'string'
          ? f.configuration.trim()
          : f.configuration && typeof f.configuration === 'object'
            ? JSON.stringify(f.configuration)
            : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractManagedClusterSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate managed cluster "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    const parsed = parseJsonObject(spec.configurationRaw)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.configuration`, message: `Configuration must be a JSON object: ${parsed.error}`, code: 'invalid_configuration' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
