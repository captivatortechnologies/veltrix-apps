import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- IBM QRadar Ariel lookup constraints --------------------------------------
//
// POST /ariel/lookups (create), POST /ariel/lookups/{name} (update
// default_value + map only — the type is immutable), DELETE /ariel/lookups/{name}
// (delete). Identity is the lookup NAME.

export const FIELD_TYPES = [
  'NULL', 'STRUCT', 'Byte', 'Short', 'Integer', 'Long', 'UnsignedByte', 'UnsignedShort',
  'UnsignedInt', 'UnsignedLong', 'BigInteger', 'Double', 'Float', 'Port', 'Host',
  'HostV4V6', 'HostV6', 'MACAddress', 'String', 'ByteArray', 'UnsignedIntHex', 'Boolean', 'Binary',
] as const

export interface LookupEntry {
  key: string
  value: string
}

export interface ArielLookupSpec {
  itemId?: string
  /** name — the lookup's identity in the /ariel/lookups API. */
  name: string
  /** the VALUE field type (immutable after creation). */
  type: string
  defaultValue: string
  entries: LookupEntry[]
}

/** An Ariel lookup as returned by GET /ariel/lookups. */
export interface LiveArielLookup {
  name?: string
  type?: string
  default_value?: string
  map?: Record<string, string>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Parse "key=value" lines into entries (first '=' splits key from value). */
export function parseLookupEntries(v: unknown): LookupEntry[] {
  const lines = Array.isArray(v) ? v.map((x) => String(x)) : asString(v).split(/\n/)
  const out: LookupEntry[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const eq = line.indexOf('=')
    if (eq < 0) {
      out.push({ key: line, value: '' })
    } else {
      out.push({ key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() })
    }
  }
  return out
}

export function extractArielLookupSpecs(canvas: CanvasSnapshot): ArielLookupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      type: asString(f.type) || 'String',
      defaultValue: asString(f.defaultValue),
      entries: parseLookupEntries(f.entries),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractArielLookupSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate Ariel lookup "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(FIELD_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({ field: `${prefix}.type`, message: `Field type must be one of: ${FIELD_TYPES.join(', ')}`, code: 'invalid_field_type' })
    }

    const seenKeys = new Set<string>()
    spec.entries.forEach((e, ei) => {
      if (!e.key) errors.push({ field: `${prefix}.entries[${ei}]`, message: 'Each entry needs a key (key=value)', code: 'missing_key' })
      if (e.key && seenKeys.has(e.key.toLowerCase())) {
        errors.push({ field: `${prefix}.entries[${ei}]`, message: `Duplicate key "${e.key}" in this lookup`, code: 'duplicate_key' })
      }
      if (e.key) seenKeys.add(e.key.toLowerCase())
    })

    if (spec.entries.length === 0 && !spec.defaultValue) {
      warnings.push({ field: `${prefix}.entries`, message: 'This lookup has no entries and no default value', code: 'empty_lookup' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
