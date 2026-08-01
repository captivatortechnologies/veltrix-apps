import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCybereasonUrl,
  createSession,
  resolveTimeoutMs,
  looksLikeLoginPage,
  type CybereasonSession,
} from '../../lib/cybereasonApi'
import {
  ISOLATION_ENDPOINTS,
  buildIsolationBody,
  rulesFromResponse,
  indexByIdentity,
  ruleIdentity,
  createdRuleId,
  type IsolationRule,
} from './_shared'

/**
 * Deploy Cybereason isolation rules over the REST API:
 *   read (rollback): GET  /rest/settings/isolation-rule   → prior snapshot
 *   update:          PUT  /rest/settings/isolation-rule   when the composite exists
 *   create:          POST /rest/settings/isolation-rule   otherwise
 *
 * Upsert is by the composite identity (ipAddressString | direction | port). A PUT
 * carries the live rule's ruleId + lastUpdated (concurrency token). rollbackData
 * records, per rule, the prior rule (null when new) and the created ruleId so
 * rollback can restore the prior values or delete the created rule.
 */
async function listRules(session: CybereasonSession): Promise<IsolationRule[]> {
  try {
    const res = await session.get(ISOLATION_ENDPOINTS.list)
    if (!res.ok || looksLikeLoginPage(res.body)) return []
    return rulesFromResponse(res.body)
  } catch {
    return []
  }
}

interface PreviousRule {
  identity: string
  prior: IsolationRule | null
  createdRuleId: string | null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) return { success: false, message: 'Missing credential for isolation-rule deployment' }

  const base = buildCybereasonUrl(component, connectivity, connectivityProvider)
  const timeoutMs = resolveTimeoutMs(settings)

  const previous: PreviousRule[] = []
  const applied: string[] = []

  try {
    const session = await createSession(base, credential, timeoutMs)
    const index = indexByIdentity(await listRules(session))

    for (const item of items) {
      const ip = String(item.fields.ipAddressString ?? '').trim()
      if (!ip) continue
      const identity = ruleIdentity(item.fields)
      const existing = index.get(identity) ?? null
      const body = buildIsolationBody(item.fields, existing)

      if (existing) {
        const res = await session.putJson(ISOLATION_ENDPOINTS.update, body)
        if (!res.ok || looksLikeLoginPage(res.body)) {
          throw new Error(`isolation-rule PUT → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        }
        previous.push({ identity, prior: existing, createdRuleId: null })
      } else {
        const res = await session.postJson(ISOLATION_ENDPOINTS.create, body)
        if (!res.ok || looksLikeLoginPage(res.body)) {
          throw new Error(`isolation-rule POST → HTTP ${res.status}: ${res.body.slice(0, 200)}`)
        }
        previous.push({ identity, prior: null, createdRuleId: createdRuleId(res.body) || null })
      }
      applied.push(identity)
    }

    return {
      success: true,
      message: `Applied ${applied.length} isolation rule(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Isolation-rule deploy failed after ${applied.length} item(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
