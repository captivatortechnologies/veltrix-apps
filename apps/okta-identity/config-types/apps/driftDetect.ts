import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { findApp } from './deploy'
import {
  extractAppSpecs,
  parseJsonObject,
  stripCredentialSecrets,
  stripX5c,
  type LiveApp,
} from './validate'

/**
 * Detect drift between the deployed app configuration and the live Okta org.
 * Each declared app is re-found by its (label, signOnMode) identity and its
 * authored blobs are compared as a SUBSET of the live object:
 *   - settings      — type-specific settings (critical), x5c cert material stripped
 *   - credentials   — (critical) WRITE-ONLY SECRETS stripped from BOTH sides
 *   - visibility    — (critical)
 *   - accessibility — (critical)
 *   - profile       — (critical)
 *   - status        — managed via lifecycle; compared separately (warning)
 *
 * Okta injects many server-populated defaults on create (especially for OIDC), so
 * the authored blobs are compared as a SUBSET of the live blob — a live object
 * that also carries Okta's defaults does not read as drift. Server-managed fields
 * (id / created / lastUpdated / status / orn / features / universalLogout /
 * _links / _embedded) are never authored so they cannot read as drift. The
 * write-only credentials secrets (oauthClient.client_secret, signing.*, x5c) are
 * stripped from both the authored and the live credentials before diffing — Okta
 * never returns them, so keeping them would ALWAYS report false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractAppSpecs(ctx.deployedConfig).filter((s) => s.label && s.signOnMode)

  for (const spec of specs) {
    try {
      const live = await findApp(client, spec.label, spec.signOnMode)

      if (!live) {
        diffs.push({ field: spec.label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // settings — strip embedded x5c cert material; subset comparison.
      compareBlob(diffs, spec.label, 'settings', spec.settingsJson, (live.settings ?? {}) as Record<string, unknown>, stripX5c)

      // credentials — strip the write-only secrets from BOTH sides before diffing.
      compareBlob(
        diffs,
        spec.label,
        'credentials',
        spec.credentialsJson,
        (live.credentials ?? {}) as Record<string, unknown>,
        stripCredentialSecrets,
      )

      // visibility / accessibility / profile — plain subset comparison.
      compareBlob(diffs, spec.label, 'visibility', spec.visibilityJson, (live.visibility ?? {}) as Record<string, unknown>)
      compareBlob(
        diffs,
        spec.label,
        'accessibility',
        spec.accessibilityJson,
        (live.accessibility ?? {}) as Record<string, unknown>,
      )
      compareBlob(diffs, spec.label, 'profile', spec.profileJson, (live.profile ?? {}) as Record<string, unknown>)

      // status — managed via lifecycle endpoints; compared separately (warning).
      const liveStatus = (live.status ?? '').toString().toUpperCase()
      const desiredStatus = (spec.status ?? '').toUpperCase()
      if (desiredStatus && liveStatus && desiredStatus !== liveStatus) {
        diffs.push({
          field: `${spec.label}.status`,
          expected: spec.status,
          actual: live.status ?? 'not set',
          severity: 'warning',
        })
      }
    } catch (error) {
      diffs.push({
        field: spec.label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/**
 * Compare one authored JSON blob against the live blob as a SUBSET, pushing a
 * critical diff when the live object does not contain the authored one. An
 * optional `sanitize` strips write-only material from BOTH sides first. No-op
 * when the blob is not authored.
 */
function compareBlob(
  diffs: DriftDiff[],
  label: string,
  key: string,
  authoredJson: string | undefined,
  live: Record<string, unknown>,
  sanitize?: (blob: Record<string, unknown> | null | undefined) => Record<string, unknown>,
): void {
  if (!authoredJson) return
  const authored = parseJsonObject(authoredJson)
  if (!authored) return

  const expected = sanitize ? sanitize(authored) : authored
  const actual = sanitize ? sanitize(live) : live
  if (!isSubset(expected, actual)) {
    diffs.push({
      field: `${label}.${key}`,
      expected: stableStringify(expected),
      actual: stableStringify(actual),
      severity: 'critical',
    })
  }
}

/**
 * True when every key in `expected` is present in `actual` with an equal value.
 * Objects recurse; arrays and primitives compare by stable stringify. Lets a
 * declared blob subset match a live object that also carries Okta's server
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
