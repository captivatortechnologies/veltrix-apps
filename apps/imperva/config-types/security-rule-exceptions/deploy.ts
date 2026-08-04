import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildImpervaClient, fetchSiteStatus, SECURITY_EXCEPTION_CONFIGURE_PATH, isApiSuccess, apiMessage, parseJson, type ImpervaClient, type ImpervaEnvelope } from '../../lib/impervaApi'
import { exceptionParams, exceptionSignature, liveExceptionFields, readExceptionFields, ruleFamily, statusRulesFor, type ExceptionFields } from './_shared'

/**
 * Deploy Imperva Cloud WAF security rule exceptions over the legacy v1 API.
 * Unlike a singleton config (Security Rules, ACL Configuration), MULTIPLE
 * exceptions can exist per (site, rule) with no operator-facing name, so this
 * reconciles by CONTENT within each declared (site, rule) group:
 *   read:   POST /sites/status              { site_id }  (rules[].exceptions[])
 *   add:    POST /sites/configure/whitelists { site_id, rule_id, exception_id_only: true, ... }
 *   delete: POST /sites/configure/whitelists { site_id, rule_id, whitelist_id, delete_whitelist: true }
 *
 * A declared exception whose signature (see ./_shared exceptionSignature)
 * matches a live one is left untouched (no API call — its whitelist_id is
 * unaffected). A declared exception with no live match is ADDED; a live
 * exception with no declared match (within a declared group) is DELETED.
 * `rollbackData.previous` records, per (site, rule), the whitelist_ids created
 * (rollback deletes them) and the full bodies of any deleted (rollback
 * re-adds them — a NEW whitelist_id is assigned, content only, same caveat
 * documented throughout this app for content-only restores).
 */

interface PriorEntry {
  siteId: string
  ruleId: string
  created: Array<{ whitelistId: string | number }>
  deleted: Array<{ fields: ExceptionFields }>
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  const built = buildImpervaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  // Group declared items by (siteId, ruleId) — that pair scopes one reconciliation.
  const groups = new Map<string, { siteId: string; ruleId: string; declared: ExceptionFields[] }>()
  for (const item of items) {
    const fields = readExceptionFields(item.fields)
    const family = ruleFamily(fields.ruleId)
    if (!fields.siteId || !family) continue
    const key = `${fields.siteId}::${fields.ruleId}`
    if (!groups.has(key)) groups.set(key, { siteId: fields.siteId, ruleId: fields.ruleId, declared: [] })
    groups.get(key)!.declared.push(fields)
  }

  const previous: PriorEntry[] = []
  const applied: string[] = []

  try {
    for (const { siteId, ruleId, declared } of groups.values()) {
      const family = ruleFamily(ruleId)!
      const status = await fetchSiteStatus(client, siteId)
      const rule = statusRulesFor(status, family).find((r) => r.id === ruleId)
      const liveExceptions = rule?.exceptions ?? []

      const liveBySignature = new Map(liveExceptions.map((exc) => [exceptionSignature(liveExceptionFields(ruleId, siteId, exc)), exc]))
      const declaredSignatures = new Set<string>()
      const created: PriorEntry['created'] = []
      const deleted: PriorEntry['deleted'] = []

      for (const fields of declared) {
        const signature = exceptionSignature(fields)
        declaredSignatures.add(signature)
        if (liveBySignature.has(signature)) continue // already present — no-op
        const whitelistId = await addException(client, siteId, ruleId, fields)
        if (whitelistId != null) created.push({ whitelistId })
      }

      for (const [signature, exception] of liveBySignature) {
        if (declaredSignatures.has(signature) || exception.id == null) continue
        await deleteException(client, siteId, ruleId, exception.id)
        deleted.push({ fields: liveExceptionFields(ruleId, siteId, exception) })
      }

      previous.push({ siteId, ruleId, created, deleted })
      applied.push(`${ruleId} (site ${siteId}): +${created.length} -${deleted.length}`)
    }

    return {
      success: true,
      message: `Applied security rule exceptions for ${applied.length} (site, rule) group(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Security rule exception deploy failed after ${applied.length} group(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}

async function addException(client: ImpervaClient, siteId: string, ruleId: string, fields: ExceptionFields): Promise<string | number | null> {
  const res = await client.post(SECURITY_EXCEPTION_CONFIGURE_PATH, {
    site_id: siteId,
    rule_id: ruleId,
    exception_id_only: 'true',
    ...exceptionParams(fields),
  })
  const json = parseJson<{ res?: number | string; exception_id?: string }>(res.body)
  if (!res.ok || !isApiSuccess(json as ImpervaEnvelope)) {
    throw new Error(`add exception (rule ${ruleId}, site ${siteId}) → HTTP ${res.status}: ${apiMessage(json as ImpervaEnvelope)}`)
  }
  return json?.exception_id ?? null
}

async function deleteException(client: ImpervaClient, siteId: string, ruleId: string, whitelistId: string | number): Promise<void> {
  const res = await client.post(SECURITY_EXCEPTION_CONFIGURE_PATH, {
    site_id: siteId,
    rule_id: ruleId,
    whitelist_id: whitelistId,
    delete_whitelist: 'true',
  })
  const json = parseJson<ImpervaEnvelope>(res.body)
  if (!res.ok || !isApiSuccess(json)) throw new Error(`delete exception ${whitelistId} (rule ${ruleId}, site ${siteId}) → HTTP ${res.status}: ${apiMessage(json)}`)
}
