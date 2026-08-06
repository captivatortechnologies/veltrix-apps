import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { createAccount, updateAccount, type GzAccount } from '../../lib/gravityZoneApi'
import {
  accountEmail,
  accountFieldsMatch,
  accountId,
  extractUserAccountSpecs,
  listAllAccounts,
  parseRights,
  resolveAccountRights,
  userAccountKey,
} from './_shared'

export interface UserAccountRollbackEntry {
  email: string
  action: 'created' | 'updated' | 'unchanged'
  newAccountId?: string
  prior?: { fullName: string; role?: number; timezone?: string; language?: string; targetIds: string[]; rights: Record<string, unknown> | null }
}

/**
 * Deploy GravityZone user accounts, reconciled by email:
 *   create: accounts.createAccount    when no live account has this email
 *   update: accounts.updateAccount    when the account exists but a comparable field differs
 *   no-op:  nothing                    when the live account already matches
 *
 * Password is write-only (see _shared.ts) — when set, it is sent on every
 * create/update rather than compared, since GravityZone never returns a
 * stored password to diff against.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractUserAccountSpecs(ctx.canvas).filter((s) => s.email && s.fullName)
  const previous: UserAccountRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const live = await listAllAccounts(client)
    const liveByEmail = new Map<string, GzAccount>(live.filter((a) => accountEmail(a)).map((a) => [userAccountKey(accountEmail(a)), a]))

    for (const spec of specs) {
      const match = liveByEmail.get(userAccountKey(spec.email))
      const { value: rights } = parseRights(spec)

      if (!match) {
        const created = await createAccount(client, {
          email: spec.email,
          profile: { fullName: spec.fullName, timezone: spec.timezone || undefined, language: spec.language || undefined },
          password: spec.password || undefined,
          role: spec.role || undefined,
          rights: spec.role === 5 && rights ? rights : undefined,
          targetIds: spec.targetIds.length ? spec.targetIds : undefined,
        })
        previous.push({ email: spec.email, action: 'created', newAccountId: created.id })
      } else {
        const id = accountId(match)
        const liveRights = await resolveAccountRights(client, match)
        const matches = accountFieldsMatch(spec, match, liveRights)

        if (!matches || spec.password) {
          previous.push({
            email: spec.email,
            action: 'updated',
            prior: {
              fullName: match.profile?.fullName ?? match.fullName ?? '',
              role: typeof match.role === 'number' ? match.role : undefined,
              timezone: match.profile?.timezone,
              language: match.profile?.language,
              targetIds: Array.isArray(match.targetIds) ? match.targetIds.map(String) : [],
              rights: liveRights,
            },
          })
          await updateAccount(client, {
            accountId: id,
            email: spec.email,
            fullName: spec.fullName,
            role: spec.role || undefined,
            timezone: spec.timezone || undefined,
            language: spec.language || undefined,
            password: spec.password || undefined,
            rights: spec.role === 5 && rights ? rights : undefined,
            targetIds: spec.targetIds,
          })
        } else {
          previous.push({ email: spec.email, action: 'unchanged' })
        }
      }
      deployed.push(spec.email)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} user account(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `User account deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  }
}
