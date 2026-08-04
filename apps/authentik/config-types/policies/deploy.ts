import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildAuthentikUrl,
  buildApiBase,
  resolveApiToken,
  resolveVerifyTls,
  findByName,
  sendJson,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/authentikApi'
import {
  buildCreateBody,
  buildPatchBody,
  POLICY_ENDPOINT_SEGMENT,
  readPolicyType,
  snapshotManagedFields,
  type AuthentikPolicy,
  type ManagedPolicyFields,
  type PolicyType,
} from './_shared'

/**
 * Deploy authentik Policies over the Core API. Each item's Type selects a
 * DIFFERENT authentik model/endpoint:
 *   read (identity): GET   /policies/<type>/?name=<name>   → list + exact-match
 *   create:           POST  /policies/<type>/                the type's *PolicyRequest
 *   update:           PATCH /policies/<type>/{policy_uuid}/   the type's Patched*PolicyRequest
 *
 * Retyping an existing item (changing Type after a prior deploy) is NOT
 * migrated: a new policy is created under the new type's endpoint, and the
 * old one under the previous type is left in place (untouched) — see
 * canvas.yaml's header comment.
 */
interface PreviousEntry {
  name: string
  type: PolicyType
  pk: string | null
  existed: boolean
  prior: ManagedPolicyFields | null
}
interface CreatedPolicy {
  pk?: string
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const token = resolveApiToken(credential)
  if (!token) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const base = buildApiBase(buildAuthentikUrl(component, connectivity, connectivityProvider))
  const verifyTls = resolveVerifyTls(settings)

  const previous: PreviousEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const type = readPolicyType(item.fields.type)
      const listUrl = `${base}/policies/${POLICY_ENDPOINT_SEGMENT[type]}/`

      const existing = await findByName<AuthentikPolicy>(listUrl, token, name, { verifyTls })

      if (existing && existing.pk) {
        await sendJson('PATCH', `${listUrl}${encodeURIComponent(existing.pk)}/`, token, buildPatchBody(item.fields), { verifyTls })
        previous.push({ name, type, pk: existing.pk, existed: true, prior: snapshotManagedFields(existing, type) })
      } else {
        const created = await sendJson<CreatedPolicy>('POST', listUrl, token, buildCreateBody(item.fields), { verifyTls })
        previous.push({ name, type, pk: created?.pk ?? null, existed: false, prior: null })
      }
      applied.push(`${name} (${type})`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} polic(y/ies): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `authentik policy deploy failed after ${applied.length} polic(y/ies): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
