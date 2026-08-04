import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildCortexClient } from '../../lib/cortexXdrApi'
import { EXTERNAL_APPLICATION_BASE, findApplication, applicationsFromResponse } from './_shared'

/**
 * Drift for external applications: compare the description and application_type
 * we declare against the live application in Cortex XDR. `connection_config` is
 * not diffed — providers commonly mask secrets (webhook auth, AWS keys, Splunk
 * HEC tokens) on read, so a byte-for-byte comparison would raise false drift.
 * Best-effort — an application that can't be matched (missing / transient error)
 * is skipped rather than raising false drift. Read-only:
 * GET /platform/integration/v1/external-application.
 *
 * VERIFY the list response shape + field names, and the auth requirement (see
 * cortexXdrApi.ts), against a live Cortex XDR tenant.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let live
  try {
    const res = await client.request('GET', EXTERNAL_APPLICATION_BASE)
    if (!res.ok) return { hasDrift: false, diffs } // best-effort: can't read, no drift asserted
    live = applicationsFromResponse(res.reply)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findApplication(live, name)
    if (!match) continue

    const expectedType = String(item.fields.application_type ?? '').trim().toLowerCase()
    const actualType = String(match.application_type ?? '').trim().toLowerCase()
    if (expectedType && expectedType !== actualType) {
      diffs.push({ field: `${name}.application_type`, expected: expectedType, actual: actualType, severity: 'warning' })
    }

    const expectedDescription = String(item.fields.description ?? '').trim()
    const actualDescription = String(match.description ?? '').trim()
    if (expectedDescription && expectedDescription !== actualDescription) {
      diffs.push({ field: `${name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
