import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import {
  LIST_NOTIFIERS_FOR_RESOLUTION_QUERY,
  LIST_TRIGGERS_QUERY,
  findTrigger,
  normalizeBool,
  notifierIdsOf,
  notifierRefsFromList,
  recipientIdsOf,
  resolveNotifierIds,
  toStringList,
  triggersFromList,
} from './_shared'

/**
 * Drift for notification triggers: compare `event_types`, `instance_trigger`,
 * declared recipients, and the resolved set of attached notifier ids (all
 * order-insensitive where they are lists) against the live trigger in OpenCTI
 * (matched by name). `filters` is declared but intentionally not diffed (a
 * free-form JSON blob OpenCTI may reformat, same precedent as the sibling
 * retention-rules/stream-collections/taxii-collections types). Best-effort — a
 * trigger that can't be matched (missing / transient error) is skipped rather
 * than raising false drift. Read-only: triggers, notifiers.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  let liveNotifiers
  try {
    live = triggersFromList(await graphql<unknown>(base, headers, LIST_TRIGGERS_QUERY))
    liveNotifiers = notifierRefsFromList(await graphql<unknown>(base, headers, LIST_NOTIFIERS_FOR_RESOLUTION_QUERY))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read live state, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findTrigger(live, name)
    if (!match) continue

    const expectedEventTypes = toStringList(item.fields.event_types).slice().sort()
    const actualEventTypes = (Array.isArray(match.event_types) ? match.event_types : []).slice().sort()
    if (JSON.stringify(expectedEventTypes) !== JSON.stringify(actualEventTypes)) {
      diffs.push({ field: `${name}.event_types`, expected: expectedEventTypes.join(', '), actual: actualEventTypes.join(', '), severity: 'warning' })
    }

    const expectedInstance = normalizeBool(item.fields.instance_trigger, false)
    const actualInstance = match.instance_trigger ?? false
    if (expectedInstance !== actualInstance) {
      diffs.push({ field: `${name}.instance_trigger`, expected: expectedInstance, actual: actualInstance, severity: 'info' })
    }

    const expectedRecipients = toStringList(item.fields.recipients).slice().sort()
    const actualRecipients = recipientIdsOf(match).slice().sort()
    if (JSON.stringify(expectedRecipients) !== JSON.stringify(actualRecipients)) {
      diffs.push({
        field: `${name}.recipients`,
        expected: expectedRecipients.join(', ') || '(none)',
        actual: actualRecipients.join(', ') || '(none)',
        severity: 'info',
      })
    }

    const { ids: expectedNotifierIds } = resolveNotifierIds(toStringList(item.fields.notifier_names), liveNotifiers)
    const expectedSorted = expectedNotifierIds.slice().sort()
    const actualSorted = notifierIdsOf(match).slice().sort()
    if (JSON.stringify(expectedSorted) !== JSON.stringify(actualSorted)) {
      diffs.push({
        field: `${name}.notifiers`,
        expected: expectedSorted.join(', ') || '(none)',
        actual: actualSorted.join(', ') || '(none)',
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
