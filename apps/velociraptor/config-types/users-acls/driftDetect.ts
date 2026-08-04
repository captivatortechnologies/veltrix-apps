import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import {
  buildClient,
  vqlTimeoutMs,
  readUsers,
  findUser,
  parseRoles,
  parsePermissions,
  GUI_USERS_VQL,
  type LiveUser,
} from './_shared'

/** Compare two role lists as sets (order-independent). */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((x) => set.has(x))
}

/**
 * Drift for users-acls: a declared user missing on the server is critical drift;
 * a user whose live roles differ from the declared roles is a warning. Role
 * comparison is best-effort — when gui_users() does not surface roles for a user,
 * only presence is checked. Read-only: SELECT * FROM gui_users().
 *
 * VERIFY against a live Velociraptor server: gui_users() columns (see ./_shared.ts).
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
    let live: LiveUser[]
    try {
      live = readUsers(await client.runVQL(GUI_USERS_VQL, { timeoutMs: vqlTimeoutMs(settings) }))
    } catch {
      return { hasDrift: false, diffs }
    }

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const desired = parseRoles(item.fields.roles)
      const match = findUser(live, name)

      if (!match) {
        diffs.push({ field: `${name}.presence`, expected: 'present', actual: 'missing', severity: 'critical' })
        continue
      }
      // Only assert role drift when the server surfaced roles (best-effort).
      if (match.roles.length > 0 && !sameSet(desired, match.roles)) {
        diffs.push({
          field: `${name}.roles`,
          expected: desired.join(', ') || '(none)',
          actual: match.roles.join(', ') || '(none)',
          severity: 'warning',
        })
      }

      // Only assert custom-permission drift when the server surfaced a policy
      // dict (best-effort — see readUsers()).
      const desiredPermissions = parsePermissions(item.fields.customPermissions)
      if (match.permissions !== null && !sameSet(desiredPermissions, match.permissions)) {
        diffs.push({
          field: `${name}.customPermissions`,
          expected: desiredPermissions.join(', ') || '(none)',
          actual: match.permissions.join(', ') || '(none)',
          severity: 'warning',
        })
      }
    }

    return { hasDrift: diffs.length > 0, diffs }
  } finally {
    await client.close().catch(() => {})
  }
}
