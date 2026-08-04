import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCybereasonUrl,
  createSession,
  resolveTimeoutMs,
  looksLikeLoginPage,
  type CybereasonSession,
} from '../../lib/cybereasonApi'
import {
  POLICY_ENDPOINTS,
  buildPolicyBody,
  policiesFromResponse,
  policyDetailFromResponse,
  findPolicyByName,
  type PolicyListRow,
} from './_shared'

/**
 * Deploy Cybereason sensor policies over the REST API:
 *   read (reconcile + rollback): GET /rest/policies (list) + GET /rest/policies/{id} (detail)
 *   update:                      PUT /rest/policies/{id}   when a policy of that name exists — UNVERIFIED, see _shared.ts
 *   create:                      POST /rest/policies        otherwise
 *
 * Upsert is by policy NAME. rollbackData records, per policy, the prior
 * `configuration` (null when it did not exist before) and — for a policy this
 * deploy CREATED — the new GUID (re-resolved by re-listing, since the create
 * response shape is not independently confirmed), so rollback can restore the
 * prior configuration or delete the created policy.
 */
async function listPolicies(session: CybereasonSession): Promise<PolicyListRow[]> {
  try {
    const res = await session.get(POLICY_ENDPOINTS.list)
    if (!res.ok || looksLikeLoginPage(res.body)) return []
    return policiesFromResponse(res.body)
  } catch {
    return []
  }
}

interface PreviousPolicy {
  name: string
  id: string | null
  prior: Record<string, unknown> | null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) return { success: false, message: 'Missing credential for sensor-policy deployment' }

  const base = buildCybereasonUrl(component, connectivity, connectivityProvider)
  const timeoutMs = resolveTimeoutMs(settings)

  const previous: PreviousPolicy[] = []
  const applied: string[] = []

  try {
    const session = await createSession(base, credential, timeoutMs)
    let live = await listPolicies(session)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const body = buildPolicyBody(item.fields)
      const existing = findPolicyByName(live, name)

      if (existing?.id) {
        const detailRes = await session.get(POLICY_ENDPOINTS.get(existing.id))
        const detail = detailRes.ok && !looksLikeLoginPage(detailRes.body) ? policyDetailFromResponse(detailRes.body) : null
        const prior = detail?.configuration ?? null

        const res = await session.putJson(POLICY_ENDPOINTS.update(existing.id), body)
        if (!res.ok || looksLikeLoginPage(res.body)) {
          throw new Error(
            `policies PUT → HTTP ${res.status}: ${res.body.slice(0, 200)} — this update endpoint is inferred from ` +
              `Cybereason's Groups resource and is not independently confirmed; verify it against your tenant`,
          )
        }
        previous.push({ name, id: existing.id, prior })
      } else {
        const res = await session.postJson(POLICY_ENDPOINTS.create, body)
        if (!res.ok || looksLikeLoginPage(res.body)) {
          throw new Error(`policies POST → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        }
        // The create response shape is not independently confirmed — re-list
        // and match by name to recover the new policy's GUID for rollback.
        live = await listPolicies(session)
        const created = findPolicyByName(live, name)
        previous.push({ name, id: created?.id ?? null, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} sensor polic${applied.length === 1 ? 'y' : 'ies'}: ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Sensor-policy deploy failed after ${applied.length} item(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
