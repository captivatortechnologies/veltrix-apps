import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { findIdp } from './deploy'
import { extractIdpSpecs, parseJsonObject, stripClientSecret } from './validate'

/**
 * Detect drift between the deployed IdP configuration and the live Okta org.
 * Each declared IdP is re-found by name and its meaningful fields are compared:
 *   - type      — the IdP kind (critical)
 *   - protocol  — endpoints/scopes/credentials (critical), CLIENT SECRET STRIPPED
 *   - policy    — provisioning/accountLink/subject mapping (critical)
 *   - status    — managed via lifecycle; compared separately (warning)
 *
 * Server-managed readOnly fields (id, created, lastUpdated, system, _links,
 * _embedded) are never modeled so they cannot read as drift. The authored
 * protocol/policy are compared as a SUBSET of the live object so Okta's own
 * server-populated defaults do not read as drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractIdpSpecs(ctx.deployedConfig).filter((s) => s.name && s.type)

  for (const spec of specs) {
    try {
      const live = await findIdp(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // type — a defining field of the IdP.
      const liveType = (live.type ?? '').toString()
      if (spec.type !== liveType) {
        diffs.push({
          field: `${spec.name}.type`,
          expected: spec.type,
          actual: liveType || 'not set',
          severity: 'critical',
        })
      }

      // protocol — STRIP the write-only client secret from BOTH sides before
      // diffing. Okta stores protocol.credentials.client.client_secret write-only
      // and never returns it on a GET, so leaving it in would ALWAYS report drift
      // against a live protocol that cannot echo it back. Stripping it from both
      // the authored and the live protocol is exactly how the secret is excluded
      // from drift detection — it is only verified at deploy time, when written.
      const authoredProtocol = spec.protocolJson ? parseJsonObject(spec.protocolJson) : null
      if (authoredProtocol) {
        const expectedProtocol = stripClientSecret(authoredProtocol)
        const liveProtocol = stripClientSecret(live.protocol ?? {})
        if (!isSubset(expectedProtocol, liveProtocol)) {
          diffs.push({
            field: `${spec.name}.protocol`,
            expected: stableStringify(expectedProtocol),
            actual: stableStringify(liveProtocol),
            severity: 'critical',
          })
        }
      }

      // policy — provisioning/accountLink/subject mapping; subset comparison so
      // Okta's server-populated defaults do not read as drift.
      const authoredPolicy = spec.policyJson ? parseJsonObject(spec.policyJson) : null
      if (authoredPolicy) {
        const livePolicy = (live.policy as Record<string, unknown> | undefined) ?? {}
        if (!isSubset(authoredPolicy, livePolicy)) {
          diffs.push({
            field: `${spec.name}.policy`,
            expected: stableStringify(authoredPolicy),
            actual: stableStringify(livePolicy),
            severity: 'critical',
          })
        }
      }

      // status — managed via lifecycle endpoints; compared separately (warning).
      const liveStatus = (live.status ?? '').toString().toUpperCase()
      const desiredStatus = (spec.status ?? '').toUpperCase()
      if (desiredStatus && liveStatus && desiredStatus !== liveStatus) {
        diffs.push({
          field: `${spec.name}.status`,
          expected: spec.status,
          actual: live.status ?? 'not set',
          severity: 'warning',
        })
      }
    } catch (error) {
      diffs.push({
        field: spec.name,
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
 * declared protocol/policy subset match a live object that also carries server
 * defaults, so those defaults do not read as drift.
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
