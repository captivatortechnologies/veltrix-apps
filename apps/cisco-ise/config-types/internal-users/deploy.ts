import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  ersBase,
  buildErsResourceClient,
  readIseSettings,
  hasUsableCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type InternalUser,
  type IdentityGroup,
} from '../../lib/iseApi'
import { extractSpecs, toInternalUserBody, stripSecrets } from './_shared'

/**
 * Deploy internal users over the ERS API:
 *   read (identity + rollback):  GET  /ers/config/internaluser?filter=name.EQ.<username>
 *   read (full prior detail):    GET  /ers/config/internaluser/{id}
 *   create:                      POST /ers/config/internaluser
 *   update:                      PUT  /ers/config/internaluser/{id}
 *
 * The USERNAME is the stable identity used to upsert. Any `identity_groups`
 * names are resolved to ids via a live lookup on the IdentityGroup resource
 * (comma-joined for the wire — ERS's InternalUser.identityGroups is a single
 * string, not a JSON array) — an unresolvable name fails that item's deploy.
 *
 * ⚠ WRITE-ONLY SECRETS: `password` and `enablePassword` can never be read back
 * from ISE, so each is sent ONLY when its canvas field is non-blank, is never
 * captured into rollbackData/artifacts/logs (stripped via stripSecrets), and
 * is never drift-checked (see driftDetect.ts).
 */
export interface RollbackEntry {
  username: string
  id: string | null
  user: InternalUser | null
}

async function resolveIdentityGroupIds(
  groupClient: ReturnType<typeof buildErsResourceClient<IdentityGroup>>,
  names: string[],
): Promise<string> {
  const ids: string[] = []
  for (const name of names) {
    const group = await groupClient.findByName(name)
    if (!group) throw new Error(`Identity group "${name}" does not exist in ISE`)
    ids.push(group.id)
  }
  return ids.join(',')
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<InternalUser>(base, 'internaluser', 'InternalUser', credential, settings)
  const groupClient = buildErsResourceClient<IdentityGroup>(base, 'identitygroup', 'IdentityGroup', credential, settings)

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const spec = extractSpecs([item])[0]
      if (!spec.username) continue

      const identityGroupIds = await resolveIdentityGroupIds(groupClient, spec.identityGroupNames)
      const body = toInternalUserBody(spec, identityGroupIds)

      const existing = await client.findByName(spec.username)
      if (existing) {
        const prior = await client.getById(existing.id)
        await client.update(existing.id, body)
        previous.push({ username: spec.username, id: existing.id, user: prior ? stripSecrets(prior) : null })
      } else {
        const newId = await client.create(body)
        previous.push({ username: spec.username, id: newId, user: null })
      }
      applied.push(spec.username)
    }

    return {
      success: true,
      message: `Applied ${applied.length} internal user(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Internal user deploy failed after ${applied.length} user(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
