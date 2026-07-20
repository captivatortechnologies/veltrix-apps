import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { getSchema, schemaLabel } from './deploy'
import { extractProfileSchemaSpecs } from './validate'

/**
 * Detect drift between the deployed profile-schema configuration and the live Okta
 * org. For each declared schema, only the MANAGED custom attributes are compared:
 *   - a managed attribute declared with a definition should be PRESENT and match as
 *     a SUBSET (so Okta-injected defaults — master/mutability/scope/permissions —
 *     do not read as drift); a missing one is CRITICAL.
 *   - a managed attribute declared as `null` (a removal) should be ABSENT; a lingering
 *     one is a WARNING.
 * Unmanaged custom attributes and all base attributes are never inspected.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractProfileSchemaSpecs(ctx.deployedConfig).filter(
    (s) => (s.schemaType === 'user' || s.schemaType === 'group') && s.attributes !== null,
  )

  for (const spec of specs) {
    const schemaType = spec.schemaType as 'user' | 'group'
    const label = schemaLabel(schemaType, spec.userTypeId)
    try {
      const live = await getSchema(client, schemaType, spec.userTypeId)
      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveProps = live.definitions?.custom?.properties ?? {}
      for (const [name, desired] of Object.entries(spec.attributes ?? {})) {
        const present = Object.prototype.hasOwnProperty.call(liveProps, name)
        const liveAttr = liveProps[name]

        if (desired === null) {
          // Declared for removal — it should be absent.
          if (present) {
            diffs.push({
              field: `${label}.${name}`,
              expected: 'absent',
              actual: 'present',
              severity: 'warning',
            })
          }
          continue
        }

        if (!present) {
          diffs.push({ field: `${label}.${name}`, expected: 'present', actual: 'missing', severity: 'critical' })
          continue
        }

        // Subset compare so Okta-populated defaults do not read as drift.
        if (!isSubset(desired, liveAttr)) {
          diffs.push({
            field: `${label}.${name}`,
            expected: stableStringify(desired),
            actual: stableStringify(liveAttr),
            severity: 'warning',
          })
        }
      }
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/**
 * True when every key in `expected` is present in `actual` with an equal value.
 * Objects recurse; arrays and primitives compare by stable stringify. Lets a
 * declared attribute definition match a live one that also carries Okta defaults,
 * so those defaults do not read as drift.
 */
function isSubset(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== 'object') {
    return stableStringify(expected) === stableStringify(actual)
  }
  if (Array.isArray(expected)) {
    return stableStringify(expected) === stableStringify(actual)
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false
  const exp = expected as Record<string, unknown>
  const act = actual as Record<string, unknown>
  return Object.keys(exp).every((key) => isSubset(exp[key], act[key]))
}

/** Deterministic JSON stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
