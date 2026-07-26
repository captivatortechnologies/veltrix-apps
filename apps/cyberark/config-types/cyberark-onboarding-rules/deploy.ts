import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCyberArkClient,
  cyberArkErrorMessage,
  parseCollectionArray,
  type CyberArkClient,
} from '../../lib/cyberark'
import {
  extractOnboardingRuleSpecs,
  ruleKey,
  type LiveOnboardingRule,
  type OnboardingRuleSpec,
} from './validate'

/**
 * Rollback state for one onboarding rule. `prior` carries the live rule so an
 * updated rule can be restored field-for-field.
 */
export interface OnboardingRuleRollbackEntry {
  key: string
  label: string
  existed: boolean
  ruleId?: number
  prior?: LiveOnboardingRule
}

/**
 * Deploy CyberArk automatic onboarding rules via the PVWA REST API.
 *
 * Identity is the rule name: list /AutomaticOnboardingRules, match on RuleName,
 * then PUT an existing rule by its RuleId (a full replace) or POST a new one.
 * A rule's RuleId is re-read after create so it can be captured for rollback.
 *
 * NOTE: the PUT is a FULL REPLACE — CyberArk resets any managed field that is not
 * sent to its default — so deploy always sends the complete managed body.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, pvwaUrl } = built

  const specs = extractOnboardingRuleSpecs(ctx.canvas).filter((s) => s.ruleName && s.targetPlatformId && s.targetSafeName)
  const rollbackState: OnboardingRuleRollbackEntry[] = []
  const createdRuleIds: number[] = []
  const deployed: string[] = []

  try {
    const byKey = await mapRules(client)

    for (const spec of specs) {
      const label = spec.ruleName
      const key = ruleKey(spec)
      const live = byKey.get(key)

      if (live && live.RuleId !== undefined) {
        rollbackState.push({ key, label, existed: true, ruleId: live.RuleId, prior: live })
        const res = await client.request('PUT', `/AutomaticOnboardingRules/${live.RuleId}/`, { body: buildRuleBody(spec) })
        if (!res.ok) throw new Error(`Failed to update rule "${label}": ${cyberArkErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/AutomaticOnboardingRules/', { body: buildRuleBody(spec) })
        if (!res.ok) throw new Error(`Failed to create rule "${label}": ${cyberArkErrorMessage(res)}`)
        // The Add response does not carry the RuleId; re-read it by name so the
        // created rule can be deleted on rollback.
        const created = await findRuleByName(client, spec.ruleName)
        rollbackState.push({ key, label, existed: false, ruleId: created?.RuleId })
        if (created?.RuleId !== undefined) createdRuleIds.push(created.RuleId)
      }
      deployed.push(label)
    }

    await client.logoff()
    return {
      success: true,
      message: `Deployed ${deployed.length} onboarding rule(s) to ${pvwaUrl}: ${deployed.join(', ')}`,
      artifacts: { pvwaUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdRuleIds },
    }
  } catch (error) {
    await client.logoff()
    return {
      success: false,
      message: `Onboarding rule deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { pvwaUrl, deployedRules: deployed },
      rollbackData: { previousState: rollbackState, createdRuleIds },
    }
  }
}

// --- Helpers ---

/** List all onboarding rules; throws on a non-OK response. */
export async function listRules(client: CyberArkClient): Promise<LiveOnboardingRule[]> {
  const res = await client.request('GET', '/AutomaticOnboardingRules/')
  if (!res.ok) {
    throw new Error(`Failed to list onboarding rules: ${cyberArkErrorMessage(res)}`)
  }
  return parseCollectionArray<LiveOnboardingRule>(res.body, ['AutomaticOnboardingRules'])
}

/** Index live rules by their natural key (rule name, lower-cased). */
export async function mapRules(client: CyberArkClient): Promise<Map<string, LiveOnboardingRule>> {
  const rules = await listRules(client)
  return new Map(
    rules.filter((r) => typeof r.RuleName === 'string' && r.RuleName).map((r) => [ruleKey({ ruleName: r.RuleName as string }), r]),
  )
}

/** Find one rule by name (case-insensitive). Uses the ?name= server-side filter. */
export async function findRuleByName(client: CyberArkClient, name: string): Promise<LiveOnboardingRule | null> {
  const res = await client.request('GET', '/AutomaticOnboardingRules/', { query: { name } })
  if (!res.ok) return null
  const rules = parseCollectionArray<LiveOnboardingRule>(res.body, ['AutomaticOnboardingRules'])
  const wanted = name.toLowerCase()
  return rules.find((r) => (r.RuleName ?? '').toLowerCase() === wanted) ?? null
}

/**
 * Build the request body shared by create (POST) and update (PUT). The username /
 * address filters are only sent when set; their match method is always sent (the
 * API ignores it when its filter is absent). RuleName is always sent so an update
 * never triggers CyberArk's auto-generated-name fallback.
 */
export function buildRuleBody(spec: OnboardingRuleSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    RuleName: spec.ruleName,
    RuleDescription: spec.ruleDescription,
    TargetPlatformId: spec.targetPlatformId,
    TargetSafeName: spec.targetSafeName,
    SystemTypeFilter: spec.systemTypeFilter,
    MachineTypeFilter: spec.machineTypeFilter,
    AccountCategoryFilter: spec.accountCategoryFilter,
    IsAdminIDFilter: spec.isAdminIdFilter,
    UserNameMethod: spec.userNameMethod,
    AddressMethod: spec.addressMethod,
  }
  if (spec.userNameFilter) body.UserNameFilter = spec.userNameFilter
  if (spec.addressFilter) body.AddressFilter = spec.addressFilter
  return body
}
