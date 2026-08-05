import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient, barracudaErrorMessage } from '../../lib/barracudaWaf'
import {
  buildHeaderRuleBody,
  extractHeaderRuleSpecs,
  headerRuleKey,
  headerRulePath,
  listHeaderRules,
  type LiveHeaderRule,
} from './validate'

export type HeaderRuleRollbackEntry =
  | { action: 'created'; name: string }
  | { action: 'updated'; name: string; prior: LiveHeaderRule }
  | { action: 'deleted'; name: string; prior: LiveHeaderRule }

export interface HeaderAllowDenyRollbackData {
  entries: HeaderRuleRollbackEntry[]
}

/**
 * Deploy the Application's Header Allow/Deny rules via
 * /applications/{appName}/headers_allow_deny/rules/.
 *
 * This config type OWNS the rule set: the canvas is the complete desired
 * list, reconciled by rule name. Existing rules not declared are removed;
 * declared rules not yet present are created (POST); declared rules that
 * already exist are updated (PUT) unconditionally, so any out-of-band edit is
 * corrected. Every touched rule's prior state is captured for rollback.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl, appName } = built

  const specs = extractHeaderRuleSpecs(ctx.canvas).filter((s) => s.name)
  const rollback: HeaderRuleRollbackEntry[] = []
  let created = 0
  let updated = 0
  let removed = 0

  try {
    const existing = await listHeaderRules(client, appName)
    const byKey = new Map(existing.filter((r) => r.name).map((r) => [headerRuleKey(r.name as string), r]))
    const declaredKeys = new Set(specs.map((s) => headerRuleKey(s.name)))

    for (const spec of specs) {
      const key = headerRuleKey(spec.name)
      const live = byKey.get(key)
      const body = buildHeaderRuleBody(spec)

      if (live) {
        rollback.push({ action: 'updated', name: spec.name, prior: live })
        const res = await client.request('PUT', headerRulePath(client, appName, spec.name), { body })
        if (!res.ok) throw new Error(`Failed to update Header Allow/Deny rule "${spec.name}": ${barracudaErrorMessage(res)}`)
        updated++
      } else {
        const res = await client.request('POST', `${client.appPath(appName)}/headers_allow_deny/rules/`, { body })
        if (!res.ok) throw new Error(`Failed to create Header Allow/Deny rule "${spec.name}": ${barracudaErrorMessage(res)}`)
        rollback.push({ action: 'created', name: spec.name })
        created++
      }
    }

    for (const rule of existing) {
      if (!rule.name || declaredKeys.has(headerRuleKey(rule.name))) continue
      rollback.push({ action: 'deleted', name: rule.name, prior: rule })
      const res = await client.request('DELETE', headerRulePath(client, appName, rule.name))
      if (res.status !== 404 && !res.ok) {
        throw new Error(`Failed to remove undeclared Header Allow/Deny rule "${rule.name}": ${barracudaErrorMessage(res)}`)
      }
      removed++
    }

    return {
      success: true,
      message: `Deployed Header Allow/Deny rules to Application "${appName}": ${created} created, ${updated} updated, ${removed} removed.`,
      artifacts: { baseUrl, appName, created, updated, removed },
      rollbackData: { entries: rollback } satisfies HeaderAllowDenyRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Header Allow/Deny deployment failed after ${created + updated} upsert(s), ${removed} removal(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, appName, created, updated, removed },
      rollbackData: { entries: rollback } satisfies HeaderAllowDenyRollbackData,
    }
  }
}
