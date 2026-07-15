import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { findEventHook, headersFingerprint } from './deploy'
import {
  DEFAULT_AUTH_HEADER_KEY,
  extractEventHookSpecs,
  normalizeHeaders,
  parseHeadersArray,
} from './validate'

/**
 * Detect drift between the deployed event-hook configuration and the live Okta
 * org. Each declared hook is re-found by name and its meaningful fields are
 * compared:
 *   - subscribed event types (events.items, order-insensitive)
 *   - channel URI, auth header KEY and extra headers
 *   - status (lifecycle-managed) — compared separately as a WARNING
 *
 * The auth header VALUE (channel.config.authScheme.value) is a WRITE-ONLY secret
 * Okta never returns, so it is NEVER compared — it cannot read as drift.
 * Server-managed readOnly fields (id, created, lastUpdated, verificationStatus,
 * _links, _embedded) are never modeled so they cannot read as drift either.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractEventHookSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const live = await findEventHook(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // events.items — the subscribed event types (a defining field), compared
      // order-insensitively so re-ordering does not read as drift.
      const expectedEvents = [...spec.eventItems].sort()
      const liveEvents = [...(live.events?.items ?? [])].map(String).sort()
      if (JSON.stringify(expectedEvents) !== JSON.stringify(liveEvents)) {
        diffs.push({
          field: `${spec.name}.events`,
          expected: expectedEvents,
          actual: liveEvents,
          severity: 'critical',
        })
      }

      const liveConfig = live.channel?.config ?? {}

      // channel URI
      const liveUri = (liveConfig.uri ?? '').toString()
      if (spec.uri !== liveUri) {
        diffs.push({
          field: `${spec.name}.channel.uri`,
          expected: spec.uri,
          actual: liveUri || 'not set',
          severity: 'critical',
        })
      }

      // channel auth header KEY (the VALUE is the write-only secret — never diffed)
      const desiredKey = spec.authHeaderKey || DEFAULT_AUTH_HEADER_KEY
      const liveKey = (liveConfig.authScheme?.key ?? '').toString()
      if (desiredKey !== liveKey) {
        diffs.push({
          field: `${spec.name}.channel.authHeaderKey`,
          expected: desiredKey,
          actual: liveKey || 'not set',
          severity: 'critical',
        })
      }

      // channel extra headers (values ARE returned for custom headers)
      const desiredHeaders = spec.headersJson
        ? normalizeHeaders(parseHeadersArray(spec.headersJson) ?? [])
        : []
      const liveHeaders = Array.isArray(liveConfig.headers) ? liveConfig.headers : []
      if (headersFingerprint(desiredHeaders) !== headersFingerprint(liveHeaders)) {
        diffs.push({
          field: `${spec.name}.channel.headers`,
          expected: desiredHeaders,
          actual: liveHeaders,
          severity: 'critical',
        })
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
