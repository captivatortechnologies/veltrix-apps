import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, readPfsenseSettings, type PfsenseUser } from '../../lib/pfsenseApi'
import { extractSpecs, snapshotUser, toUserCreateBody, toUserUpdateBody, userKey } from './_shared'

export interface RollbackEntry {
  name: string
  id: number | string | null
  prior: Omit<PfsenseUser, 'id' | 'password'> | null
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { previous?: RollbackEntry[] } | undefined
    return Array.isArray(data?.previous) ? data!.previous : []
  } catch {
    return []
  }
}

/**
 * Deploy local users over the pfSense REST API package:
 *   list:    GET  /api/v2/users
 *   create:  POST /api/v2/user (password REQUIRED)
 *   update:  PATCH /api/v2/user (password OMITTED when blank — keeps the
 *            current password; see _shared.ts's toUserUpdateBody)
 *   delete (a user this app created but no longer declares):
 *            DELETE /api/v2/user
 * NO apply step — User is `always_apply` server-side (verified:
 * `local_user_set`/`local_user_del` run synchronously inside create/update/
 * delete), unlike every firewall/NAT/routing/DNS config type in this app.
 *
 * System-scoped users (`scope !== 'user'`, e.g. "admin") are NEVER touched —
 * skipped entirely when matching live users and never deleted during
 * cleanup. A user created without a password (blank on a brand-new item)
 * fails at the API and is surfaced as a deploy error, not silently skipped.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readPfsenseSettings(ctx.settings)
  const built = buildPfsenseClient(component, connectivity, credential, settings, connectivityProvider)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const auth = await client.authenticate()
  if (auth.error) return { success: false, message: auth.error }

  const specs = extractSpecs(items).filter((s) => s.name)
  const previous: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const live = await client.listUsers()
    // Only ever match/touch regular ("user"-scope) accounts — pfSense itself
    // refuses to delete any other scope (verified: User::_delete()), and
    // this app never even attempts to update a system-reserved account.
    const liveByName = new Map(live.filter((u) => u.name && (u.scope ?? 'user') === 'user').map((u) => [userKey(u.name), u]))
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const match = liveByName.get(userKey(spec.name)) ?? null

      if (match && match.id !== undefined) {
        await client.updateUser(match.id, toUserUpdateBody(spec))
        previous.push({ name: spec.name, id: match.id, prior: snapshotUser(match) })
        updated++
      } else {
        const createdUser = await client.createUser(toUserCreateBody(spec))
        previous.push({ name: spec.name, id: createdUser.id ?? null, prior: null })
        created++
      }
    }

    const declaredNames = new Set(specs.map((s) => userKey(s.name)))
    for (const p of prior) {
      if (p.prior !== null || declaredNames.has(userKey(p.name)) || p.id === null) continue
      await client.deleteUser(p.id)
      deleted++
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} pfSense user(s) on ${host}: ${created} created, ${updated} updated, ${deleted} removed.`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Deploy failed after ${created} created, ${updated} updated, ${deleted} removed: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { previous },
    }
  }
}
