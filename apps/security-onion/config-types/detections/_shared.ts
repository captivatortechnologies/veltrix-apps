// Shared helpers for the Kibana Detection Engine config type (deploy + driftDetect).

/** Indices Security Onion detection rules run against (cross-cluster + local so-*). */
export const DETECTION_INDEX = ['*:so-*', 'so-*']

/** `enabled` may arrive as a boolean or an 'enabled'/'disabled' string; normalize to boolean. */
export function normalizeEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'disabled' || s === 'false' || s === '0') return false
  return true
}
