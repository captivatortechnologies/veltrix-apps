// =============================================================================
// Shared JSON helpers for config types that carry a flat map of Qualys API
// parameters as a JSON field (option profiles' scan settings, dynamic search
// lists' criteria). Parsing is NON-UNION { value, error } (the platform handler
// loader can't narrow discriminated unions).
// =============================================================================

import type { QualysParams } from '../../lib/qualys'

export interface FlatObjectResult {
  value: Record<string, unknown> | null
  error: string | null
}

/**
 * Parse a JSON string into a FLAT object of scalar values. By default an empty
 * string is an error ("is required"); pass `allowEmpty` to treat it as an empty
 * object instead. Nested objects/arrays are rejected — every value must be a
 * scalar so it can be sent as a form parameter.
 */
export function parseFlatScalarObject(
  raw: string | undefined,
  opts?: { allowEmpty?: boolean },
): FlatObjectResult {
  const text = (raw ?? '').trim()
  if (!text) return opts?.allowEmpty ? { value: {}, error: null } : { value: null, error: 'is required' }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { value: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, error: 'must be a JSON object' }
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object') {
      return { value: null, error: `must be a flat object of scalar parameters ("${key}" is not a scalar)` }
    }
  }
  return { value: parsed as Record<string, unknown>, error: null }
}

/** Flatten a scalar object into Qualys form params (booleans → 1/0, nullish dropped). */
export function flattenScalarParams(obj: Record<string, unknown>): QualysParams {
  const params: QualysParams = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'boolean') params[key] = value ? 1 : 0
    else if (typeof value === 'number' || typeof value === 'string') params[key] = value
    else params[key] = String(value)
  }
  return params
}
