import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, listPaged } from '../../lib/sumoLogicApi'
import { findConnection, toHeaderList, type Connection } from './_shared'

/**
 * Drift for connections: compare url, description, webhookType/username and
 * (Webhook only) defaultPayload/customHeaders we declare against the live
 * connection in Sumo Logic (matched by name). Authorization headers and the
 * ServiceNow password are intentionally NOT compared — Sumo Logic never echoes
 * them back on read, so there is nothing genuine to diff against. Best-effort —
 * a connection that can't be matched is skipped. Read-only: GET /connections.
 *
 * API: https://www.sumologic.com/help/docs/api/connection-management/
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasBasicAuth(credential)) return { hasDrift: false, diffs }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let live: Connection[]
  try {
    live = await listPaged<Connection>(base, 'connections', headers)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read connections, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    const match = findConnection(live, name)
    if (!match) continue

    const expectedUrl = String(item.fields.url ?? '').trim()
    const actualUrl = String(match.url ?? '').trim()
    if (expectedUrl && actualUrl && actualUrl !== expectedUrl) {
      diffs.push({ field: `${name}.url`, expected: expectedUrl, actual: actualUrl, severity: 'warning' })
    }

    const expectedDescription = String(item.fields.description ?? '').trim()
    const actualDescription = String(match.description ?? '').trim()
    if (actualDescription !== expectedDescription) {
      diffs.push({ field: `${name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'warning' })
    }

    const type = String(item.fields.type ?? '').trim()
    if (type === 'WebhookDefinition') {
      const expectedPayload = String(item.fields.defaultPayload ?? '').trim()
      const actualPayload = String(match.defaultPayload ?? '').trim()
      if (expectedPayload && actualPayload && actualPayload !== expectedPayload) {
        diffs.push({ field: `${name}.defaultPayload`, expected: expectedPayload, actual: actualPayload, severity: 'warning' })
      }

      const expectedWebhookType = String(item.fields.webhookType ?? '').trim() || 'Webhook'
      const actualWebhookType = String(match.webhookType ?? '').trim()
      if (actualWebhookType && actualWebhookType !== expectedWebhookType) {
        diffs.push({ field: `${name}.webhookType`, expected: expectedWebhookType, actual: actualWebhookType, severity: 'warning' })
      }

      const expectedCustomHeaders = toHeaderList(item.fields.customHeaders)
      const actualCustomHeaders = toHeaderList(match.customHeaders)
      const key = (h: Array<{ name: string; value: string }>) =>
        h
          .map((x) => `${x.name}=${x.value}`)
          .sort()
          .join('|')
      if (key(expectedCustomHeaders) !== key(actualCustomHeaders)) {
        diffs.push({
          field: `${name}.customHeaders`,
          expected: key(expectedCustomHeaders),
          actual: key(actualCustomHeaders),
          severity: 'warning',
        })
      }
    } else {
      const expectedUsername = String(item.fields.username ?? '').trim()
      const actualUsername = String(match.username ?? '').trim()
      if (expectedUsername && actualUsername && actualUsername !== expectedUsername) {
        diffs.push({ field: `${name}.username`, expected: expectedUsername, actual: actualUsername, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
