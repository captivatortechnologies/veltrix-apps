import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { splitList, asBool } from '../../lib/velociraptorApi'
import { buildClient, vqlTimeoutMs, readSecrets, findSecret, SECRETS_VQL, type LiveSecret } from './_shared'

/** Compare two lists as sets (order-independent). */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((x) => set.has(x))
}

/**
 * Drift for secrets: a declared secret missing on the server is critical drift;
 * mismatched grants (users/orgs/visibility) are a warning, checked only when the
 * server surfaces them (best-effort — see ./_shared.ts). The secret's CONTENT is
 * never compared: Velociraptor's secrets API does not return it, so content
 * drift is structurally undetectable (documented, not a shortcut). Read-only:
 * SELECT * FROM secrets().
 *
 * VERIFY against a live Velociraptor server: secrets() row shape (see ./_shared.ts).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch {
    return { hasDrift: false, diffs }
  }

  try {
    let live: LiveSecret[]
    try {
      live = readSecrets(await client.runVQL(SECRETS_VQL, { timeoutMs: vqlTimeoutMs(settings) }))
    } catch {
      return { hasDrift: false, diffs }
    }

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const match = findSecret(live, name)

      if (!match) {
        diffs.push({ field: `${name}.presence`, expected: 'present', actual: 'missing', severity: 'critical' })
        continue
      }

      const desiredUsers = splitList(item.fields.grantedUsers)
      if (match.users && !sameSet(desiredUsers, match.users)) {
        diffs.push({
          field: `${name}.users`,
          expected: desiredUsers.join(', ') || '(none)',
          actual: match.users.join(', ') || '(none)',
          severity: 'warning',
        })
      }

      const desiredOrgs = splitList(item.fields.grantedOrgs)
      if (match.orgs && !sameSet(desiredOrgs, match.orgs)) {
        diffs.push({
          field: `${name}.orgs`,
          expected: desiredOrgs.join(', ') || '(none)',
          actual: match.orgs.join(', ') || '(none)',
          severity: 'warning',
        })
      }

      const desiredVisible = asBool(item.fields.visibleToAllOrgs, false)
      if (match.visibleToAllOrgs !== null && match.visibleToAllOrgs !== desiredVisible) {
        diffs.push({
          field: `${name}.visibleToAllOrgs`,
          expected: String(desiredVisible),
          actual: String(match.visibleToAllOrgs),
          severity: 'warning',
        })
      }
    }

    return { hasDrift: diffs.length > 0, diffs }
  } finally {
    await client.close().catch(() => {})
  }
}
