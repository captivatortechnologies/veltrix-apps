import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, getJson } from '../../lib/sumoLogicApi'
import { normalizeActive, toStringList, usersFromList, type SumoUser } from './_shared'

/**
 * Drift for users: compare first/last name, active state and role assignment
 * we declare against the live user in Sumo Logic (matched by email, looked up
 * directly via the `email=` filter rather than a full-org list). Roles are
 * compared as an order-insensitive set. Best-effort — a user that can't be
 * matched is skipped. Read-only: GET /users?email=<email>.
 *
 * API: https://help.sumologic.com/docs/api/user-management/
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasBasicAuth(credential)) return { hasDrift: false, diffs }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  for (const item of items) {
    const email = String(item.fields.email ?? '').trim()
    if (!email) continue

    let match: SumoUser | null = null
    try {
      const found = usersFromList(await getJson<unknown>(`${base}/users?email=${encodeURIComponent(email)}&limit=1`, headers))
      match = found[0] ?? null
    } catch {
      continue // best-effort: can't read this user, no drift asserted for them
    }
    if (!match) continue

    const expectedFirstName = String(item.fields.firstName ?? '').trim()
    const actualFirstName = String(match.firstName ?? '').trim()
    if (expectedFirstName && actualFirstName !== expectedFirstName) {
      diffs.push({ field: `${email}.firstName`, expected: expectedFirstName, actual: actualFirstName, severity: 'warning' })
    }

    const expectedLastName = String(item.fields.lastName ?? '').trim()
    const actualLastName = String(match.lastName ?? '').trim()
    if (actualLastName !== expectedLastName) {
      diffs.push({ field: `${email}.lastName`, expected: expectedLastName, actual: actualLastName, severity: 'warning' })
    }

    const expectedActive = normalizeActive(item.fields.isActive)
    const actualActive = normalizeActive(match.isActive)
    if (actualActive !== expectedActive) {
      diffs.push({ field: `${email}.isActive`, expected: expectedActive, actual: actualActive, severity: 'warning' })
    }

    const expectedRoles = toStringList(item.fields.roleIds).slice().sort()
    const actualRoles = toStringList(match.roleIds).slice().sort()
    if (expectedRoles.join('|') !== actualRoles.join('|')) {
      diffs.push({ field: `${email}.roleIds`, expected: expectedRoles.join(', '), actual: actualRoles.join(', '), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
