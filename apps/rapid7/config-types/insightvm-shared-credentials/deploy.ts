import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildInsightVMClient,
  insightVMErrorMessage,
  parseJson,
  type InsightVMClient,
} from '../../lib/insightvm'
import {
  credentialKey,
  extractCredentialSpecs,
  parseJsonObject,
  type CredentialSpec,
  type LiveCredential,
} from './validate'

/**
 * Rollback state for one credential. ⚠ Deliberately carries NO secret: the
 * write-only `account.password` is never captured, so an updated credential can
 * only be restored to its prior NON-secret fields (see rollback.ts).
 */
export interface CredentialRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: number
  prior?: { name?: string; description?: string; account?: Record<string, unknown> }
}

/**
 * Deploy Rapid7 InsightVM shared scan credentials via the Console API.
 *
 * Identity is the credential name: list /shared_credentials, match on the name,
 * then PUT an existing credential by id or POST a new one.
 *
 * ⚠ SECRET: the account password/key is write-only. The API masks it on read,
 * so `secret` is ALWAYS sent on both create and update. It is NEVER read back,
 * diffed, or stored in rollbackData / artifacts / error messages.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, consoleUrl } = built

  const specs = extractCredentialSpecs(ctx.canvas).filter((s) => s.name && s.credentialJson.trim() && s.secret)
  const rollbackState: CredentialRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listCredentials(client)
    const byKey = new Map(
      existing.filter((c) => c.name).map((c) => [credentialKey({ name: c.name as string }), c]),
    )

    for (const spec of specs) {
      const label = spec.name
      const key = credentialKey(spec)
      const live = byKey.get(key)

      if (live && live.id != null) {
        // Capture prior NON-secret state only — never the write-only password.
        rollbackState.push({
          key,
          label,
          existed: true,
          id: live.id,
          prior: { name: live.name, description: live.description, account: stripSecret(live.account) },
        })
        const res = await client.request('PUT', `/shared_credentials/${live.id}`, { body: buildBody(spec) })
        if (!res.ok) throw new Error(`Failed to update credential "${label}": ${insightVMErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/shared_credentials', { body: buildBody(spec) })
        if (!res.ok) throw new Error(`Failed to create credential "${label}": ${insightVMErrorMessage(res)}`)
        const created = parseJson<{ id?: number }>(res.body)
        if (created?.id == null) throw new Error(`Credential "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} shared credential(s) to ${consoleUrl}: ${deployed.join(', ')}`,
      // artifacts carry names only — never the secret or account contents.
      artifacts: { consoleUrl, deployedCredentials: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Shared credential deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { consoleUrl, deployedCredentials: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all shared credentials; throws on a non-OK response. */
export async function listCredentials(client: InsightVMClient): Promise<LiveCredential[]> {
  const res = await client.getAll<LiveCredential>('/shared_credentials')
  if (!res.ok) {
    throw new Error(
      `Failed to list shared credentials: ${insightVMErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/**
 * Build the request body. The account is the parsed credential JSON with the
 * write-only secret merged in as `account.password`. ⚠ The password is always
 * present here because the API masks it on read — it must be re-sent on every
 * write — but it must never leak out of this body into logs/artifacts/rollback.
 */
function buildBody(spec: CredentialSpec): Record<string, unknown> {
  const account: Record<string, unknown> = {
    ...(parseJsonObject(spec.credentialJson).value ?? {}),
    password: spec.secret,
  }
  const body: Record<string, unknown> = { name: spec.name, account }
  if (spec.description) body.description = spec.description
  return body
}

/**
 * Return a copy of a live account with the secret removed, so prior state can be
 * captured for rollback without ever persisting the write-only password (which
 * the API masks on read anyway).
 */
function stripSecret(account: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!account || typeof account !== 'object') return undefined
  const copy: Record<string, unknown> = { ...account }
  delete copy.password
  return copy
}
