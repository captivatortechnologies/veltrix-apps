import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/**
 * The fixed `source` all Veltrix-authored indicators carry. Reconciliation and
 * every list/query is scoped to this value so the config type only ever reads or
 * writes indicators it owns — TAXII / MDTI / connector-fed indicators (which carry
 * their own source) are never matched, updated or deleted.
 */
export const MANAGED_SOURCE = 'Veltrix'

/** Default confidence (0-100) when the field is left blank. */
export const DEFAULT_CONFIDENCE = 50

/**
 * The supported STIX pattern types. `value` is the canvas select value and the
 * key the deploy body maps to ARM `properties.patternType` via `stixType` (the
 * STIX Cyber-observable Object type — "file" for every hash variant). `stixLhs`
 * is the left-hand side used to wrap a bare value into a STIX comparison pattern,
 * e.g. `[ipv4-addr:value = '1.2.3.4']` or `[file:hashes.'SHA-256' = '<hash>']`.
 */
export interface PatternTypeDef {
  value: string
  label: string
  stixType: string
  stixLhs: string
}

export const PATTERN_TYPES: PatternTypeDef[] = [
  { value: 'ipv4-addr', label: 'IPv4 address', stixType: 'ipv4-addr', stixLhs: 'ipv4-addr:value' },
  { value: 'ipv6-addr', label: 'IPv6 address', stixType: 'ipv6-addr', stixLhs: 'ipv6-addr:value' },
  { value: 'domain-name', label: 'Domain name', stixType: 'domain-name', stixLhs: 'domain-name:value' },
  { value: 'url', label: 'URL', stixType: 'url', stixLhs: 'url:value' },
  { value: 'file:sha256', label: 'File hash (SHA-256)', stixType: 'file', stixLhs: "file:hashes.'SHA-256'" },
  { value: 'file:sha1', label: 'File hash (SHA-1)', stixType: 'file', stixLhs: "file:hashes.'SHA-1'" },
  { value: 'file:md5', label: 'File hash (MD5)', stixType: 'file', stixLhs: "file:hashes.'MD5'" },
]

/** Resolve a canvas patternType select value to its definition. */
export function resolvePatternType(value: string): PatternTypeDef | undefined {
  return PATTERN_TYPES.find((p) => p.value === value.trim())
}

/** An ISO-8601 date or date-time (date-only or with a time + optional offset/Z). */
export const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

/** True when a string is a plausible ISO date/date-time that also parses. */
export function isIsoDateTime(value: string): boolean {
  const t = value.trim()
  if (!ISO_DATETIME_RE.test(t)) return false
  return !Number.isNaN(Date.parse(t))
}

/** True when the pattern is already a bracketed STIX pattern (used verbatim). */
export function looksLikeStixPattern(value: string): boolean {
  const t = value.trim()
  return t.startsWith('[') && t.endsWith(']')
}

/**
 * Normalise an authored pattern into a STIX pattern. A value already wrapped in
 * brackets is used verbatim; a bare value (e.g. `1.2.3.4`) is wrapped using the
 * selected pattern type, e.g. `[ipv4-addr:value = '1.2.3.4']`. Single quotes in
 * the value are escaped so the STIX pattern stays well-formed.
 */
export function normalizePattern(rawValue: string, def: PatternTypeDef | undefined): string {
  const t = rawValue.trim()
  if (!t) return ''
  if (looksLikeStixPattern(t)) return t
  if (!def) return t
  const escaped = t.replace(/'/g, "\\'")
  return `[${def.stixLhs} = '${escaped}']`
}

/** One threat intelligence indicator authored on the canvas. */
export interface IndicatorSpec {
  sectionName: string
  /** Display name — the stable reconciliation key within the managed source. */
  displayName: string
  description: string
  /** Canvas select value (e.g. 'url', 'file:sha256'). */
  patternType: string
  /** ARM `properties.patternType` (STIX object type, e.g. 'url', 'file'). */
  stixType: string
  /** Normalised STIX pattern sent to ARM. */
  pattern: string
  /** The pattern exactly as authored (for validation messages). */
  rawPattern: string
  confidence: number
  threatTypes: string[]
  tags: string[]
  validFrom: string
  validUntil: string
  revoked: boolean
}

/**
 * The reconciliation key: creation is a POST that returns a server-assigned GUID
 * name we do not control, so indicators are matched by their display name
 * (lower-cased) among indicators of the managed source instead of by ARM name.
 */
export function indicatorKey(displayName: string): string {
  return displayName.trim().toLowerCase()
}

function readBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  return fallback
}

/** Read a tags/list field into a trimmed string array (accepts a comma string too). */
export function readList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter((v) => v.length > 0)
  return []
}

/** Parse a number field. NON-UNION result: value is null when unparseable. */
export function readNumber(value: unknown): { value: number | null; error: string | null } {
  if (typeof value === 'number' && Number.isFinite(value)) return { value, error: null }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.trim())
    if (Number.isFinite(n)) return { value: n, error: null }
    return { value: null, error: `"${value}" is not a number` }
  }
  return { value: null, error: null }
}

/** Each canvas item is one threat intelligence indicator. */
export function extractIndicatorSpecs(canvas: CanvasSnapshot): IndicatorSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const patternType = typeof fields.pattern_type === 'string' ? fields.pattern_type.trim() : ''
    const def = resolvePatternType(patternType)
    const rawPattern = typeof fields.pattern === 'string' ? fields.pattern.trim() : ''
    const confidence = readNumber(fields.confidence)
    return {
      sectionName: section.name,
      displayName: typeof fields.display_name === 'string' ? fields.display_name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      patternType,
      stixType: def?.stixType ?? patternType,
      pattern: normalizePattern(rawPattern, def),
      rawPattern,
      confidence: confidence.value ?? DEFAULT_CONFIDENCE,
      threatTypes: readList(fields.threat_types),
      tags: readList(fields.tags),
      validFrom: typeof fields.valid_from === 'string' ? fields.valid_from.trim() : '',
      validUntil: typeof fields.valid_until === 'string' ? fields.valid_until.trim() : '',
      revoked: readBool(fields.revoked, false),
    }
  })
}

/**
 * Validate threat intelligence indicators. Each needs a unique display name, a
 * known pattern type, a pattern, a confidence in 0-100, and (when supplied)
 * ISO-8601 valid-from / valid-until timestamps.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no threat intelligence indicators', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  for (const spec of extractIndicatorSpecs(ctx.canvas)) {
    const prefix = spec.sectionName

    if (!spec.displayName) {
      errors.push({ field: `${prefix}.display_name`, message: 'Display name is required', code: 'required' })
    } else {
      const key = indicatorKey(spec.displayName)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.display_name`, message: `Duplicate indicator display name "${spec.displayName}"`, code: 'duplicate_indicator' })
      }
      seen.add(key)
    }

    if (!spec.patternType) {
      errors.push({ field: `${prefix}.pattern_type`, message: 'Pattern type is required', code: 'required' })
    } else if (!resolvePatternType(spec.patternType)) {
      errors.push({
        field: `${prefix}.pattern_type`,
        message: `Pattern type must be one of ${PATTERN_TYPES.map((p) => p.value).join(', ')}`,
        code: 'invalid_pattern_type',
      })
    }

    if (!spec.rawPattern) {
      errors.push({ field: `${prefix}.pattern`, message: 'Pattern is required', code: 'required' })
    } else if (looksLikeStixPattern(spec.rawPattern) && !/=/.test(spec.rawPattern)) {
      errors.push({
        field: `${prefix}.pattern`,
        message: `Pattern "${spec.rawPattern}" looks like a STIX pattern but has no comparison expression (expected e.g. [ipv4-addr:value = '1.2.3.4'])`,
        code: 'invalid_pattern',
      })
    }

    if (!Number.isInteger(spec.confidence) || spec.confidence < 0 || spec.confidence > 100) {
      errors.push({ field: `${prefix}.confidence`, message: 'Confidence must be an integer between 0 and 100', code: 'invalid_confidence' })
    }

    if (spec.validFrom && !isIsoDateTime(spec.validFrom)) {
      errors.push({ field: `${prefix}.valid_from`, message: `Valid-from "${spec.validFrom}" must be an ISO-8601 date/time (e.g. 2024-01-31T00:00:00Z)`, code: 'invalid_datetime' })
    }

    if (spec.validUntil && !isIsoDateTime(spec.validUntil)) {
      errors.push({ field: `${prefix}.valid_until`, message: `Valid-until "${spec.validUntil}" must be an ISO-8601 date/time (e.g. 2024-12-31T00:00:00Z)`, code: 'invalid_datetime' })
    }

    if (spec.validFrom && spec.validUntil && isIsoDateTime(spec.validFrom) && isIsoDateTime(spec.validUntil)) {
      if (Date.parse(spec.validUntil) < Date.parse(spec.validFrom)) {
        errors.push({ field: `${prefix}.valid_until`, message: 'Valid-until must be on or after valid-from', code: 'invalid_validity_window' })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
