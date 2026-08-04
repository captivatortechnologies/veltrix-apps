import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { ersBase, buildErsResourceClient, readIseSettings, hasUsableCredential, type InternalUser, type IdentityGroup } from '../../lib/iseApi'
import { extractSpecs } from './_shared'

/** Render a comma-separated id list as a sorted, comparable string. */
function idListKey(csv: string | undefined): string {
  return (csv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()
    .join(',')
}

/**
 * Drift for internal users: a declared user missing from ISE is critical
 * drift; a name/email/identity-group mismatch is a warning. ⚠ Password and
 * enable-password are NEVER compared — ISE never returns them (see deploy.ts's
 * write-only secret note). Read-only. Best-effort — a user (or a referenced
 * identity group) that can't be read is skipped.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasUsableCredential(credential)) return { hasDrift: false, diffs }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<InternalUser>(base, 'internaluser', 'InternalUser', credential, settings)
  const groupClient = buildErsResourceClient<IdentityGroup>(base, 'identitygroup', 'IdentityGroup', credential, settings)

  for (const item of items) {
    const spec = extractSpecs([item])[0]
    if (!spec.username) continue

    let existing
    try {
      existing = await client.findByName(spec.username)
    } catch {
      continue
    }

    if (!existing) {
      diffs.push({ field: `${spec.username}`, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    let live
    try {
      live = await client.getById(existing.id)
    } catch {
      continue
    }
    if (!live) continue

    const fieldChecks: Array<[string, string, string]> = [
      ['description', spec.description, String(live.description ?? '').trim()],
      ['first_name', spec.firstName, String(live.firstName ?? '').trim()],
      ['last_name', spec.lastName, String(live.lastName ?? '').trim()],
      ['email', spec.email, String(live.email ?? '').trim()],
    ]
    for (const [field, expected, actual] of fieldChecks) {
      if (expected !== actual) {
        diffs.push({ field: `${spec.username}.${field}`, expected, actual, severity: 'warning' })
      }
    }

    if (spec.identityGroupNames.length > 0) {
      let expectedIds = ''
      try {
        const resolved: string[] = []
        for (const name of spec.identityGroupNames) {
          const group = await groupClient.findByName(name)
          if (group) resolved.push(group.id)
        }
        expectedIds = idListKey(resolved.join(','))
      } catch {
        continue
      }
      const actualIds = idListKey(live.identityGroups)
      if (expectedIds !== actualIds) {
        diffs.push({ field: `${spec.username}.identity_groups`, expected: expectedIds, actual: actualIds, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
