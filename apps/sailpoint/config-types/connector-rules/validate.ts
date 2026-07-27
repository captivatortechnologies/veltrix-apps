import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Connector Rule constraints --------------------------------

export const MIN_NAME_LENGTH = 1
export const MAX_NAME_LENGTH = 128

export interface ConnectorRuleSpec {
  itemId?: string
  name: string
  /** rule type, e.g. BuildMap, ConnectorBeforeCreate, WebServiceBeforeOperationRule (immutable). */
  type: string
  description: string
  /** BeanShell source version. */
  version: string
  /** BeanShell source code. */
  script: string
  /** raw JSON for the optional `signature` object. */
  signatureRaw: string
  /** raw JSON for the optional `attributes` object. */
  attributesRaw: string
}

/** A connector rule as returned by GET /beta/connector-rules. */
export interface LiveConnectorRule {
  id?: string
  name?: string
  type?: string
  description?: string | null
  sourceCode?: { version?: string; script?: string }
  signature?: Record<string, unknown> | null
  attributes?: Record<string, unknown> | null
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

export function extractConnectorRuleSpecs(canvas: CanvasSnapshot): ConnectorRuleSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      type: asString(f.type),
      description: asString(f.description),
      version: asString(f.version) || '1.0',
      script: typeof f.script === 'string' ? f.script : '',
      signatureRaw:
        typeof f.signature === 'string'
          ? f.signature.trim()
          : f.signature && typeof f.signature === 'object'
            ? JSON.stringify(f.signature)
            : '',
      attributesRaw:
        typeof f.attributes === 'string'
          ? f.attributes.trim()
          : f.attributes && typeof f.attributes === 'object'
            ? JSON.stringify(f.attributes)
            : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractConnectorRuleSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length < MIN_NAME_LENGTH || spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be between ${MIN_NAME_LENGTH} and ${MAX_NAME_LENGTH} characters`, code: 'invalid_length' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate connector rule "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'A rule type is required (e.g. BuildMap, ConnectorBeforeCreate)', code: 'required' })
    }
    if (!spec.script.trim()) {
      errors.push({ field: `${prefix}.script`, message: 'Rule source code is required', code: 'required' })
    }

    const sig = parseJsonObject(spec.signatureRaw)
    if (!sig.ok) {
      errors.push({ field: `${prefix}.signature`, message: `Signature must be a JSON object: ${sig.error}`, code: 'invalid_signature' })
    }
    const attrs = parseJsonObject(spec.attributesRaw)
    if (!attrs.ok) {
      errors.push({ field: `${prefix}.attributes`, message: `Attributes must be a JSON object: ${attrs.error}`, code: 'invalid_attributes' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
