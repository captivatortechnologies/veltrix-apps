import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Source Schema constraints ---------------------------------
// A source schema is a nested child of a source, keyed within its parent by
// `name` (e.g. account, group). The parent source is resolved by name → id.

export interface SourceSchemaSpec {
  itemId?: string
  /** name of the parent source (resolved to an id at deploy time). */
  sourceName: string
  /** schema name, e.g. "account" or "group" (the key within the source). */
  name: string
  nativeObjectType: string
  identityAttribute: string
  displayAttribute: string
  hierarchyAttribute: string
  includePermissions: boolean
  /** raw JSON for the `attributes` array (AttributeDefinition[]). */
  attributesRaw: string
  /** raw JSON for the `configuration` object. */
  configurationRaw: string
}

/** A schema as returned by GET /v3/sources/{sourceId}/schemas. */
export interface LiveSourceSchema {
  id?: string
  name?: string
  nativeObjectType?: string
  identityAttribute?: string
  displayAttribute?: string
  hierarchyAttribute?: string
  includePermissions?: boolean
  attributes?: Array<Record<string, unknown>>
  configuration?: Record<string, unknown>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function parseJsonArray(
  raw: string
): { ok: true; value: unknown[] } | { ok: false; error: string } {
  if (!raw) return { ok: true, value: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' }
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'must be a JSON array' }
  return { ok: true, value: parsed }
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

export function extractSourceSchemaSpecs(canvas: CanvasSnapshot): SourceSchemaSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      sourceName: asString(f.sourceName),
      name: asString(f.name) || item.name,
      nativeObjectType: asString(f.nativeObjectType),
      identityAttribute: asString(f.identityAttribute),
      displayAttribute: asString(f.displayAttribute),
      hierarchyAttribute: asString(f.hierarchyAttribute),
      includePermissions: asBool(f.includePermissions),
      attributesRaw:
        typeof f.attributes === 'string'
          ? f.attributes.trim()
          : Array.isArray(f.attributes)
            ? JSON.stringify(f.attributes)
            : '',
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
  const specs = extractSourceSchemaSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.sourceName) {
      errors.push({ field: `${prefix}.sourceName`, message: 'A parent source name is required', code: 'required' })
    }
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Schema name is required (e.g. account, group)', code: 'required' })
    }

    if (spec.sourceName && spec.name) {
      const key = `${spec.sourceName.toLowerCase()}::${spec.name.toLowerCase()}`
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate schema "${spec.name}" for source "${spec.sourceName}"`, code: 'duplicate_name' })
      }
      seen.add(key)
    }

    const attrs = parseJsonArray(spec.attributesRaw)
    if (!attrs.ok) {
      errors.push({ field: `${prefix}.attributes`, message: `Attributes must be a JSON array: ${attrs.error}`, code: 'invalid_attributes' })
    }
    const cfg = parseJsonObject(spec.configurationRaw)
    if (!cfg.ok) {
      errors.push({ field: `${prefix}.configuration`, message: `Configuration must be a JSON object: ${cfg.error}`, code: 'invalid_configuration' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
