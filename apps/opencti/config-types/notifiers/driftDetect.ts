import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { LIST_NOTIFIERS_QUERY, findNotifier, normalizeText, notifiersFromList } from './_shared'

/**
 * Drift for notifiers: compare the notifier_connector_id we declare against
 * the live notifier in OpenCTI (matched by name). `notifier_configuration` is
 * declared but deliberately NOT diffed beyond presence — OpenCTI may
 * reformat/reorder the stored JSON string, so a strict string-equality
 * comparison would create false positives (same "free-form JSON blob, skip
 * the diff" precedent other apps use). Best-effort — a notifier that can't be
 * matched (missing / transient error) is skipped rather than raising false
 * drift. Read-only: notifiers.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = notifiersFromList(await graphql<unknown>(base, headers, LIST_NOTIFIERS_QUERY))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read notifiers, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findNotifier(live, name)
    if (!match) continue

    const expectedConnectorId = normalizeText(item.fields.notifier_connector_id)
    const actualConnectorId = normalizeText(match.notifier_connector_id)
    if (expectedConnectorId !== undefined && actualConnectorId !== undefined && expectedConnectorId !== actualConnectorId) {
      diffs.push({
        field: `${name}.notifier_connector_id`,
        expected: expectedConnectorId,
        actual: actualConnectorId,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
