import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { findInlineHook } from './deploy'
import {
  DEFAULT_AUTH_HEADER_KEY,
  SECRET_CONFIG_KEYS,
  extractInlineHookSpecs,
  parseChannelConfig,
} from './validate'

/**
 * Detect drift between the deployed inline-hook configuration and the live Okta
 * org. Each declared hook is re-found by (name, type) and its authored fields are
 * compared. Server-managed readOnly fields (id, created, lastUpdated, system,
 * _links, _embedded) are never modeled so they cannot read as drift; status is
 * managed by the lifecycle endpoints and is compared separately (warning).
 *
 * WRITE-ONLY SECRETS ARE EXCLUDED. The HTTP secret (channel.config.authScheme.value)
 * is modeled as a password field that is never compared, and the OAUTH secret
 * (channel.config.clientSecret) is skipped when diffing the config blob — Okta
 * never returns either, so comparing them would always read as drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractInlineHookSpecs(ctx.deployedConfig).filter((s) => s.name && s.type)

  for (const spec of specs) {
    try {
      const live = await findInlineHook(client, spec.name, spec.type)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveChannel = live.channel ?? {}
      const liveConfig = (liveChannel.config ?? {}) as Record<string, unknown>

      // channel type — HTTP vs OAUTH is a defining transport field.
      const liveChannelType = (liveChannel.type ?? '').toString().toUpperCase()
      if (spec.channelType && spec.channelType !== liveChannelType) {
        diffs.push({
          field: `${spec.name}.channelType`,
          expected: spec.channelType,
          actual: liveChannelType || 'not set',
          severity: 'critical',
        })
      }

      // uri — the external endpoint the hook calls.
      const liveUri = (liveConfig.uri ?? '').toString()
      if (spec.uri !== liveUri) {
        diffs.push({
          field: `${spec.name}.uri`,
          expected: spec.uri,
          actual: liveUri || 'not set',
          severity: 'critical',
        })
      }

      // HTTP auth header KEY — compared; the VALUE is write-only and never compared.
      if (spec.channelType === 'HTTP') {
        const liveScheme = (liveConfig.authScheme ?? {}) as Record<string, unknown>
        const liveKey = (liveScheme.key ?? '').toString()
        const desiredKey = spec.authHeaderKey || DEFAULT_AUTH_HEADER_KEY
        if (liveKey && desiredKey !== liveKey) {
          diffs.push({
            field: `${spec.name}.authHeaderKey`,
            expected: desiredKey,
            actual: liveKey,
            severity: 'warning',
          })
        }
      }

      // OAUTH config blob — diff each declared key against the live channel config,
      // SKIPPING the write-only secret keys (clientSecret) that Okta never returns.
      if (spec.channelType === 'OAUTH') {
        const config = spec.configJson ? parseChannelConfig(spec.configJson) : {}
        if (config) {
          for (const key of Object.keys(config)) {
            if ((SECRET_CONFIG_KEYS as readonly string[]).includes(key)) continue
            if (key === 'uri') continue // compared above from the modeled field
            const expected = stableStringify(config[key] ?? null)
            const actual = stableStringify(liveConfig[key] ?? null)
            if (expected !== actual) {
              diffs.push({
                field: `${spec.name}.${key}`,
                expected: config[key] ?? 'not set',
                actual: liveConfig[key] ?? 'not set',
                severity: 'critical',
              })
            }
          }
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

/** Deterministic JSON stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
