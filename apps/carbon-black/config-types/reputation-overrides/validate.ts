import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Carbon Black reputation override constraints ----------------------------

export const OVERRIDE_LISTS = ['BLACK_LIST', 'WHITE_LIST'] as const
export const OVERRIDE_TYPES = ['SHA256', 'CERT', 'IT_TOOL'] as const
const SHA256_RE = /^[a-fA-F0-9]{64}$/

export interface OverrideSpec {
  itemId?: string
  /** A friendly label — the canvas identity. Not sent to Carbon Black. */
  label: string
  overrideList: string
  overrideType: string
  sha256Hash: string
  filename: string
  signedBy: string
  certificateAuthority: string
  path: string
  includeChildProcesses: boolean
  description: string
}

/** A reputation override as returned by the CBC search/get. */
export interface LiveOverride {
  id?: string
  override_list?: string
  override_type?: string
  sha256_hash?: string
  filename?: string
  signed_by?: string
  certificate_authority?: string
  path?: string
  include_child_processes?: boolean
  description?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function extractOverrideSpecs(canvas: CanvasSnapshot): OverrideSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      label: asString(f.label) || item.name,
      overrideList: (asString(f.overrideList) || 'BLACK_LIST').toUpperCase(),
      overrideType: (asString(f.overrideType) || 'SHA256').toUpperCase(),
      sha256Hash: asString(f.sha256Hash),
      filename: asString(f.filename),
      signedBy: asString(f.signedBy),
      certificateAuthority: asString(f.certificateAuthority),
      path: asString(f.path),
      includeChildProcesses: asBool(f.includeChildProcesses),
      description: asString(f.description),
    }
  })
}

/** The natural key an override is matched on (type + its identifying value). */
export function naturalKey(spec: OverrideSpec): string {
  if (spec.overrideType === 'SHA256') return `sha256:${spec.sha256Hash.toLowerCase()}`
  if (spec.overrideType === 'CERT') return `cert:${spec.signedBy.toLowerCase()}|${spec.certificateAuthority.toLowerCase()}`
  return `ittool:${spec.path}`
}

/** The natural key of a live override (mirrors naturalKey for specs). */
export function liveNaturalKey(live: LiveOverride): string {
  const type = (live.override_type ?? '').toUpperCase()
  if (type === 'SHA256') return `sha256:${(live.sha256_hash ?? '').toLowerCase()}`
  if (type === 'CERT') return `cert:${(live.signed_by ?? '').toLowerCase()}|${(live.certificate_authority ?? '').toLowerCase()}`
  return `ittool:${live.path ?? ''}`
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractOverrideSpecs(ctx.canvas)
  const seenLabels = new Set<string>()
  const seenKeys = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.label) {
      errors.push({ field: `${prefix}.label`, message: 'Label is required', code: 'required' })
    } else {
      const key = spec.label.toLowerCase()
      if (seenLabels.has(key)) {
        errors.push({ field: `${prefix}.label`, message: `Duplicate label "${spec.label}"`, code: 'duplicate_label' })
      }
      seenLabels.add(key)
    }

    if (!(OVERRIDE_LISTS as readonly string[]).includes(spec.overrideList)) {
      errors.push({ field: `${prefix}.overrideList`, message: `List must be one of: ${OVERRIDE_LISTS.join(', ')}`, code: 'invalid_list' })
    }
    if (!(OVERRIDE_TYPES as readonly string[]).includes(spec.overrideType)) {
      errors.push({ field: `${prefix}.overrideType`, message: `Type must be one of: ${OVERRIDE_TYPES.join(', ')}`, code: 'invalid_type' })
      return
    }

    // type-specific required identifiers
    if (spec.overrideType === 'SHA256') {
      if (!spec.sha256Hash) errors.push({ field: `${prefix}.sha256Hash`, message: 'A SHA256 override needs a hash', code: 'missing_hash' })
      else if (!SHA256_RE.test(spec.sha256Hash)) errors.push({ field: `${prefix}.sha256Hash`, message: 'SHA256 hash must be 64 hex characters', code: 'invalid_hash' })
    } else if (spec.overrideType === 'CERT') {
      if (!spec.signedBy) errors.push({ field: `${prefix}.signedBy`, message: 'A CERT override needs a "signed by" value', code: 'missing_signed_by' })
    } else if (spec.overrideType === 'IT_TOOL') {
      if (!spec.path) errors.push({ field: `${prefix}.path`, message: 'An IT_TOOL override needs a path', code: 'missing_path' })
    }

    // natural-key uniqueness (two items can't manage the same override)
    const nk = naturalKey(spec)
    if (nk && !nk.endsWith(':') && seenKeys.has(nk)) {
      errors.push({ field: `${prefix}`, message: `Duplicate override — another item already targets ${nk}`, code: 'duplicate_override' })
    }
    seenKeys.add(nk)
  })

  return { valid: errors.length === 0, errors, warnings }
}
