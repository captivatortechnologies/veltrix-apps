import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { findAuthenticator } from './deploy'
import {
  authenticatorIdentity,
  extractAuthenticatorSpecs,
  isNonDeactivatableKey,
  parseJsonObject,
} from './validate'

/** Provider secret keys that are write-only — never returned on GET, never diffed. */
const SECRET_CONFIG_KEYS = ['secretKey', 'integrationKey', 'sharedSecret', 'password'] as const

/**
 * Detect drift between the deployed authenticator configuration and the live
 * Okta org. Each declared authenticator is re-found by key (key+name for a
 * multi-instance key) and its MANAGED fields are compared:
 *   - settings — the declared keys must be a subset of the live settings, so
 *     Okta's own server-populated defaults do not read as drift (critical)
 *   - provider — same subset check, with the WRITE-ONLY SECRETS
 *     (secretKey/integrationKey/…) stripped from both sides: Okta never returns
 *     them, so they can never be compared and are excluded from drift (critical)
 *   - status — managed via the lifecycle endpoints; compared separately
 *     (warning), and skipped for a non-deactivatable key whose desired INACTIVE
 *     can never take effect
 *
 * Server-managed readOnly fields (id/created/lastUpdated/_links/_embedded) are
 * never modelled, so they cannot read as drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractAuthenticatorSpecs(ctx.deployedConfig).filter((s) => s.key)

  for (const spec of specs) {
    const identity = authenticatorIdentity(spec.key, spec.name)
    try {
      const live = await findAuthenticator(client, spec)

      if (!live) {
        diffs.push({ field: identity, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // settings — declared keys must be a subset of live settings.
      if (spec.settingsJson) {
        const expected = parseJsonObject(spec.settingsJson)
        if (expected && !isSubset(expected, live.settings)) {
          diffs.push({
            field: `${identity}.settings`,
            expected: stableStringify(expected),
            actual: stableStringify(live.settings ?? {}),
            severity: 'critical',
          })
        }
      }

      // provider — subset check with the write-only secrets stripped from both
      // sides so they can never register as drift.
      if (spec.providerJson) {
        const expected = stripProviderSecrets(parseJsonObject(spec.providerJson))
        const actual = stripProviderSecrets(
          live.provider && typeof live.provider === 'object' ? live.provider : undefined,
        )
        if (expected && !isSubset(expected, actual)) {
          diffs.push({
            field: `${identity}.provider`,
            expected: stableStringify(expected),
            actual: stableStringify(actual ?? {}),
            severity: 'critical',
          })
        }
      }

      // status — managed via lifecycle; compared separately (warning). Skipped
      // for a non-deactivatable key (its INACTIVE can never take effect).
      const desiredStatus = (spec.status ?? '').toUpperCase()
      const liveStatus = (typeof live.status === 'string' ? live.status : '').toUpperCase()
      const statusUnenforceable = isNonDeactivatableKey(spec.key) && desiredStatus === 'INACTIVE'
      if (desiredStatus && liveStatus && desiredStatus !== liveStatus && !statusUnenforceable) {
        diffs.push({
          field: `${identity}.status`,
          expected: spec.status,
          actual: live.status ?? 'not set',
          severity: 'warning',
        })
      }
    } catch (error) {
      diffs.push({
        field: identity,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/**
 * Return a copy of a provider object with the write-only secret configuration
 * values removed, so those never-returned fields cannot read as drift. Undefined
 * in → undefined out.
 */
export function stripProviderSecrets(
  provider: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!provider) return undefined
  const out: Record<string, unknown> = { ...provider }
  const rawConfig = out.configuration
  if (rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)) {
    const configuration: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(rawConfig as Record<string, unknown>)) {
      if (!(SECRET_CONFIG_KEYS as readonly string[]).includes(key)) configuration[key] = value
    }
    out.configuration = configuration
  }
  return out
}

/**
 * True when every key in `expected` is present in `actual` with an equal value.
 * Objects recurse; arrays and primitives compare by stable stringify. Lets a
 * declared subset match a live object that also carries Okta's server defaults,
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
