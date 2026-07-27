import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager AntiVirus profile constraints ------------------------------

export const MAX_NAME_LENGTH = 35
export const INSPECTION_MODES = ['proxy', 'flow'] as const
export const SCAN_MODES = ['quick', 'full', 'legacy', 'default'] as const

/** Per-protocol dicts (and related dicts) that may appear in the protocols JSON. */
export const PROTOCOL_KEYS = [
  'http',
  'ftp',
  'imap',
  'pop3',
  'smtp',
  'ssh',
  'cifs',
  'nntp',
  'mapi',
  'smb',
  'content-disarm',
  'outbreak-prevention',
  'nac-quar',
] as const

export interface AntivirusProfileSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  comment: string
  /** proxy | flow */
  inspectionMode: string
  /** proxy | flow */
  featureSet: string
  /** enable | disable */
  analyticsDb: string
  /** enable | disable */
  mobileMalwareDb: string
  /** quick | full | legacy | default */
  scanMode: string
  /** Raw JSON for the per-protocol dicts (validated to parse to an object). */
  protocols: string
}

/** An antivirus profile as returned by a get on the antivirus/profile table. */
export interface LiveAntivirusProfile {
  name?: string
  comment?: string
  'inspection-mode'?: string | number
  'feature-set'?: string | number
  'analytics-db'?: string | number
  'mobile-malware-db'?: string | number
  'scan-mode'?: string | number
  [key: string]: unknown
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function asToggle(v: unknown, dflt: 'enable' | 'disable' = 'disable'): string {
  if (v === true || v === 'enable' || v === 'true') return 'enable'
  return dflt
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export interface ParsedJson {
  ok: boolean
  value?: unknown
}

/** Parse a JSON textarea value. An empty value is valid (undefined). */
export function parseJsonField(raw: string): ParsedJson {
  const t = raw.trim()
  if (!t) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(t) }
  } catch {
    return { ok: false }
  }
}

export function extractAntivirusProfileSpecs(canvas: CanvasSnapshot): AntivirusProfileSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      comment: asString(f.comment),
      inspectionMode: (asString(f.inspectionMode) || 'proxy').toLowerCase(),
      featureSet: (asString(f.featureSet) || 'proxy').toLowerCase(),
      analyticsDb: asToggle(f.analyticsDb),
      mobileMalwareDb: asToggle(f.mobileMalwareDb),
      scanMode: (asString(f.scanMode) || 'default').toLowerCase(),
      protocols: typeof f.protocols === 'string' ? f.protocols : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAntivirusProfileSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate antivirus profile "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(INSPECTION_MODES as readonly string[]).includes(spec.inspectionMode)) {
      errors.push({ field: `${prefix}.inspectionMode`, message: `Inspection mode must be one of: ${INSPECTION_MODES.join(', ')}`, code: 'invalid_mode' })
    }
    if (!(INSPECTION_MODES as readonly string[]).includes(spec.featureSet)) {
      errors.push({ field: `${prefix}.featureSet`, message: `Feature set must be one of: ${INSPECTION_MODES.join(', ')}`, code: 'invalid_feature_set' })
    }
    if (!(SCAN_MODES as readonly string[]).includes(spec.scanMode)) {
      errors.push({ field: `${prefix}.scanMode`, message: `Scan mode must be one of: ${SCAN_MODES.join(', ')}`, code: 'invalid_scan_mode' })
    }

    const parsed = parseJsonField(spec.protocols)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.protocols`, message: 'Protocols must be valid JSON', code: 'invalid_json' })
    } else if (parsed.value !== undefined && !isPlainObject(parsed.value)) {
      errors.push({ field: `${prefix}.protocols`, message: 'Protocols must be a JSON object keyed by protocol (http, smtp, ...)', code: 'invalid_json_shape' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
