import type { DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    )
  }
  return value
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
}

export function diffFields(
  scope: string,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  severity: DriftDiff['severity'] = 'warning',
): DriftDiff[] {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()
  return keys
    .filter((key) => !sameValue(expected[key], actual[key]))
    .map((key) => ({ field: `${scope}.${key}`, expected: expected[key] ?? null, actual: actual[key] ?? null, severity }))
}

export function missingDiff(scope: string, what: string): DriftDiff {
  return { field: scope, expected: 'present', actual: `${what} missing`, severity: 'critical' }
}

export function driftResult(diffs: DriftDiff[]): DriftResult {
  return { hasDrift: diffs.length > 0, diffs, checked: true }
}

export function unreadableDrift(): DriftResult {
  return { hasDrift: false, diffs: [], checked: false }
}
