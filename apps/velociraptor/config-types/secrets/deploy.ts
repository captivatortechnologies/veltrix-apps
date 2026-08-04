import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { splitList, asBool } from '../../lib/velociraptorApi'
import {
  buildClient,
  vqlTimeoutMs,
  readSecrets,
  findSecret,
  parseSecretPairs,
  diffValues,
  secretAddVQL,
  secretModifyVQL,
  SECRETS_VQL,
  type LiveSecret,
} from './_shared'

/** One secret's rollback record: the grant delta this deploy applied. */
export interface SecretRollbackEntry {
  name: string
  type: string
  existed: boolean
  addedUsers: string[]
  removedUsers: string[]
  addedOrgs: string[]
  removedOrgs: string[]
  /** Prior visibility flag, when the server surfaced it (best-effort). */
  priorVisibleToAllOrgs: boolean | null
}

/**
 * Deploy Velociraptor secrets over the gRPC API (mutual TLS):
 *   read (rollback base): SELECT * FROM secrets()                    — metadata only
 *   content (write-only): SELECT secret_add(name=, type=, secret=)   — every deploy
 *   grants (reconciled):  SELECT secret_modify(name=, type=, add_users=, ...)
 *
 * The secret's CONTENT is sent on every deploy and never diffed (the server
 * never returns it — see ./_shared.ts); only GRANTS (users/orgs/visibility) are
 * reconciled to an exact desired state, added/removed relative to what
 * secrets() reports before this deploy.
 *
 * VERIFY against a live Velociraptor server: secret_add() upsert semantics and
 * the secrets() row shape (see ./_shared.ts).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for secrets deployment' }
  }

  const timeoutMs = vqlTimeoutMs(settings)
  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch (error) {
    return { success: false, message: `Could not connect to Velociraptor: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  const previous: SecretRollbackEntry[] = []
  const applied: string[] = []
  try {
    let live: LiveSecret[] = []
    try {
      live = readSecrets(await client.runVQL(SECRETS_VQL, { timeoutMs }))
    } catch {
      live = [] // best-effort: without prior state, created secrets roll back via delete
    }

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      const type = String(item.fields.type ?? '').trim()
      if (!name || !type) continue

      const secret = parseSecretPairs(String(item.fields.secretData ?? ''))
      const grantedUsers = splitList(item.fields.grantedUsers)
      const grantedOrgs = splitList(item.fields.grantedOrgs)
      const visibleToAllOrgs = asBool(item.fields.visibleToAllOrgs, false)

      const existing = findSecret(live, name)
      const priorUsers = existing?.users ?? []
      const priorOrgs = existing?.orgs ?? []

      await client.runVQL(secretAddVQL(name, type, secret), { timeoutMs })

      const addedUsers = diffValues(grantedUsers, priorUsers)
      const removedUsers = diffValues(priorUsers, grantedUsers)
      const addedOrgs = diffValues(grantedOrgs, priorOrgs)
      const removedOrgs = diffValues(priorOrgs, grantedOrgs)

      await client.runVQL(
        secretModifyVQL(name, type, {
          addUsers: addedUsers,
          removeUsers: removedUsers,
          addOrgs: addedOrgs,
          removeOrgs: removedOrgs,
          visibleToAllOrgs,
        }),
        { timeoutMs },
      )

      previous.push({
        name,
        type,
        existed: Boolean(existing),
        addedUsers,
        removedUsers,
        addedOrgs,
        removedOrgs,
        priorVisibleToAllOrgs: existing?.visibleToAllOrgs ?? null,
      })
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} secret(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Secrets deploy failed after ${applied.length} of ${items.length} secret(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } finally {
    await client.close().catch(() => {})
  }
}
