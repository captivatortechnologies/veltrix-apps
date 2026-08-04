import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildVisionOneClient } from '../../lib/visionOneApi'
import { ACCOUNT_ENDPOINTS, accountsFromResponse, findAccountByEmail, normalizeValue } from './_shared'

/**
 * Drift for user accounts — only asserted when the live list reads back cleanly.
 * A declared account that is ABSENT is drift (someone removed it, or the invite
 * was never accepted and later expired). For a present account, role, status and
 * description are compared against what we declare. Read-only: GET /iam/accounts.
 *
 * VERIFY the list response shape against a live Vision One tenant.
 */
const COMPARED_FIELDS: Array<'role' | 'status' | 'description'> = ['role', 'status', 'description']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const built = buildVisionOneClient(component?.hostname, credential, settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let live
  try {
    const res = await client.get(ACCOUNT_ENDPOINTS.list)
    if (!res.ok) return { hasDrift: false, diffs } // best-effort: can't read, no drift asserted
    live = accountsFromResponse(res.json)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const email = String(item.fields.email ?? '').trim()
    if (!email) continue
    const match = findAccountByEmail(live, email)

    if (!match) {
      diffs.push({ field: `${email}.present`, expected: 'true', actual: 'false', severity: 'warning' })
      continue
    }

    for (const field of COMPARED_FIELDS) {
      const expected = String(item.fields[field] ?? '').trim() || (field === 'status' ? 'enabled' : '')
      if (!expected) continue // an optional field left blank is not asserted
      const actual = String((match as Record<string, unknown>)[field] ?? '').trim()
      if (normalizeValue(actual) !== normalizeValue(expected)) {
        diffs.push({ field: `${email}.${field}`, expected, actual, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
