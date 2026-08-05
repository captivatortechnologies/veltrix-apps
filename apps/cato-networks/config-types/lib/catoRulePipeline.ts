// =============================================================================
// Generic deploy/rollback/driftDetect engine shared by every Cato RULE-based
// configuration type (Internet Firewall, WAN Firewall, Application Control,
// TLS Inspection, Anti-Malware File Hash). See catoPolicy.ts for the staged
// publish/revert model this builds on.
//
// ROLLBACK DESIGN: this never re-reads a rule's deep, type-specific body (source
// / destination / service / ...) back from Cato to capture a "prior" state -
// each policy area's rule shape differs too much for a generic read-shape ->
// write-shape round-trip to be worth the complexity. Instead (mirroring how
// `wiz-integrations` handles the same problem - see its rollback.ts) the prior
// state is the PREVIOUS CANVAS VERSION's own declared spec for that same rule
// name (`ctx.previousConfig`), re-run through the SAME `buildUpdateData`
// builder deploy itself uses. A rule that existed before this canvas ever
// declared it (no prior canvas version) is left alone on rollback and reported,
// never guessed at.
// =============================================================================

import type { CanvasSnapshot, DeployContext, DeployResult, DriftContext, DriftDiff, DriftResult, RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCatoClient, type CatoClient } from '../../lib/cato'
import {
  extractEnvelope,
  items,
  listPolicy,
  moveRuleDoc,
  publishPolicy,
  resolveRulePosition,
  ruleMutationDoc,
  unwrapRule,
  withPolicyRevisionConflictRetry,
  type PolicyRuleNode,
  type RulePosition,
} from './catoPolicy'

export interface RuleSpec {
  name: string
  section: string
  position: RulePosition
  positionRuleName?: string
}

export interface RuleTypeConfig<TSpec extends RuleSpec> {
  policyArea: string
  typeLabel: string
  /** The GraphQL input type for addRule, e.g. `InternetFirewallAddRuleInput!`. */
  addInputType: string
  /** The GraphQL input type for updateRule, e.g. `InternetFirewallUpdateRuleInput!`. */
  updateInputType: string
  /** The GraphQL input type for removeRule, e.g. `InternetFirewallRemoveRuleInput!`. */
  removeInputType: string
  extractSpecs: (canvas: CanvasSnapshot) => TSpec[]
  /** Build the `rule` body for addRule (must satisfy every non-defaulted required field). */
  buildAddData: (spec: TSpec) => Record<string, unknown>
  /** Build the `rule` body for updateRule (every field optional - only changed fields need be present, but sending the full declared body is simplest and idempotent). */
  buildUpdateData: (spec: TSpec) => Record<string, unknown>
}

export interface RuleRollbackEntry<TSpec extends RuleSpec> {
  name: string
  existed: boolean
  id?: string
  /** The previous canvas version's own spec for this rule name, replayed via buildUpdateData on rollback. Absent when the rule pre-dates this canvas (or on first deploy). */
  priorSpec?: TSpec
}

function findSectionId(sections: { id: string; name: string }[], name: string): string | null {
  const key = name.trim().toLowerCase()
  return sections.find((s) => s.name.trim().toLowerCase() === key)?.id ?? null
}

function findRuleByName(rules: PolicyRuleNode[], name: string): PolicyRuleNode | null {
  const key = name.trim().toLowerCase()
  return rules.find((r) => r.name.trim().toLowerCase() === key) ?? null
}

async function movePlacedRule<TSpec extends RuleSpec>(
  client: CatoClient,
  policyArea: string,
  ruleId: string,
  spec: TSpec,
  sectionId: string | null,
  liveRules: PolicyRuleNode[],
): Promise<string | null> {
  const siblingId = spec.positionRuleName ? findRuleByName(liveRules, spec.positionRuleName)?.id ?? null : null
  const to = resolveRulePosition(spec.position, sectionId, siblingId)
  const res = await client.graphql(moveRuleDoc(policyArea), { accountId: client.accountId, input: { id: ruleId, to } })
  if (res.transportError) return res.transportError
  const env = extractEnvelope(res.data, policyArea, 'moveRule', () => null)
  if (env.status !== 'SUCCESS') return env.errors.map((e) => e.errorMessage || e.errorCode).join('; ') || 'moveRule failed'
  return null
}

/** Deploy: create/update every declared rule, assert its position, then publish the staged draft once. */
export async function runRuleDeploy<TSpec extends RuleSpec>(ctx: DeployContext, config: RuleTypeConfig<TSpec>): Promise<DeployResult> {
  const built = buildCatoClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, accountId } = built

  const specs = config.extractSpecs(ctx.canvas).filter((s) => s.name)
  const previousSpecs = ctx.previousConfig ? config.extractSpecs(ctx.previousConfig) : []
  const previousByName = new Map(previousSpecs.map((s) => [s.name.trim().toLowerCase(), s]))

  const rollbackState: RuleRollbackEntry<TSpec>[] = []
  const deployed: string[] = []

  try {
    const listed = await listPolicy(client, config.policyArea)
    if (!listed.ok) throw new Error(`Failed to read ${config.typeLabel} policy: ${listed.error}`)
    let { rules, sections } = listed.value

    for (const spec of specs) {
      const sectionId = findSectionId(sections, spec.section)
      if (!sectionId) {
        throw new Error(
          `${config.typeLabel} "${spec.name}" declares section "${spec.section}", which does not exist yet - create it first with the matching Sections configuration type.`,
        )
      }

      const existing = findRuleByName(rules, spec.name)
      let ruleId: string

      if (existing) {
        const res = await client.graphql(ruleMutationDoc(config.policyArea, 'updateRule', config.updateInputType), {
          accountId,
          input: { id: existing.id, rule: config.buildUpdateData(spec) },
        })
        if (res.transportError) throw new Error(`Failed to update ${config.typeLabel} "${spec.name}": ${res.transportError}`)
        const env = extractEnvelope(res.data, config.policyArea, 'updateRule', unwrapRule)
        if (env.status !== 'SUCCESS') {
          throw new Error(`Failed to update ${config.typeLabel} "${spec.name}": ${env.errors.map((e) => e.errorMessage || e.errorCode).join('; ')}`)
        }
        ruleId = existing.id
        rollbackState.push({ name: spec.name, existed: true, id: ruleId, priorSpec: previousByName.get(spec.name.trim().toLowerCase()) })
      } else {
        const siblingId = spec.positionRuleName ? findRuleByName(rules, spec.positionRuleName)?.id ?? null : null
        const at = resolveRulePosition(spec.position, sectionId, siblingId)
        const res = await client.graphql(ruleMutationDoc(config.policyArea, 'addRule', config.addInputType), {
          accountId,
          input: { at, rule: config.buildAddData(spec) },
        })
        if (res.transportError) throw new Error(`Failed to create ${config.typeLabel} "${spec.name}": ${res.transportError}`)
        const env = extractEnvelope(res.data, config.policyArea, 'addRule', unwrapRule)
        if (env.status !== 'SUCCESS' || !env.node) {
          throw new Error(`Failed to create ${config.typeLabel} "${spec.name}": ${env.errors.map((e) => e.errorMessage || e.errorCode).join('; ')}`)
        }
        ruleId = env.node.id
        rollbackState.push({ name: spec.name, existed: false, id: ruleId })
        rules = [...rules, env.node]
      }

      if (existing) {
        const moveErr = await movePlacedRule(client, config.policyArea, ruleId, spec, sectionId, rules)
        if (moveErr) throw new Error(`Failed to position ${config.typeLabel} "${spec.name}": ${moveErr}`)
      }

      deployed.push(spec.name)
    }

    const publishAttempt = await withPolicyRevisionConflictRetry(
      () => publishPolicy(client, config.policyArea),
      (r) => (r.ok ? null : r.error),
    )
    if (!publishAttempt.ok) {
      return {
        success: false,
        message: `Staged ${deployed.length} ${config.typeLabel}(s) but publish failed: ${publishAttempt.error}. Changes are saved but not live - re-run to retry publish.`,
        artifacts: { accountId, deployed },
        rollbackData: { previousState: rollbackState },
      }
    }

    return {
      success: true,
      message: `Deployed and published ${deployed.length} ${config.typeLabel}(s) on Cato account ${accountId}: ${deployed.join(', ')}`,
      artifacts: { accountId, deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `${config.typeLabel} deployment failed after ${deployed.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { accountId, deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** Rollback: delete created rules, restore updated rules to their previous canvas spec, then publish once. */
export async function runRuleRollback<TSpec extends RuleSpec>(ctx: RollbackContext, config: RuleTypeConfig<TSpec>): Promise<RollbackResult> {
  const built = buildCatoClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, accountId } = built

  const previousState = (ctx.rollbackData as { previousState?: RuleRollbackEntry<TSpec>[] } | null)?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const restored: string[] = []
  const deleted: string[] = []
  const skipped: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.graphql(ruleMutationDoc(config.policyArea, 'removeRule', config.removeInputType), {
            accountId,
            input: { id: entry.id },
          })
          if (res.transportError) throw new Error(`Failed to delete "${entry.name}": ${res.transportError}`)
          const env = extractEnvelope(res.data, config.policyArea, 'removeRule', unwrapRule)
          if (env.status !== 'SUCCESS') {
            throw new Error(`Failed to delete "${entry.name}": ${env.errors.map((e) => e.errorMessage || e.errorCode).join('; ')}`)
          }
          deleted.push(entry.name)
        }
      } else if (entry.id && entry.priorSpec) {
        const res = await client.graphql(ruleMutationDoc(config.policyArea, 'updateRule', config.updateInputType), {
          accountId,
          input: { id: entry.id, rule: config.buildUpdateData(entry.priorSpec) },
        })
        if (res.transportError) throw new Error(`Failed to restore "${entry.name}": ${res.transportError}`)
        const env = extractEnvelope(res.data, config.policyArea, 'updateRule', unwrapRule)
        if (env.status !== 'SUCCESS') {
          throw new Error(`Failed to restore "${entry.name}": ${env.errors.map((e) => e.errorMessage || e.errorCode).join('; ')}`)
        }
        restored.push(entry.name)
      } else {
        skipped.push(entry.name)
      }
    }

    const publishAttempt = await withPolicyRevisionConflictRetry(
      () => publishPolicy(client, config.policyArea),
      (r) => (r.ok ? null : r.error),
    )
    if (!publishAttempt.ok) {
      return { success: false, message: `Reverted but publish failed: ${publishAttempt.error}. Re-run rollback to retry publish.` }
    }

    const skippedNote = skipped.length > 0 ? ` (${skipped.length} left unchanged - no prior canvas version captured: ${skipped.join(', ')})` : ''
    return {
      success: true,
      message: `Rolled back ${config.typeLabel}(s): ${restored.length} restored, ${deleted.length} deleted${skippedNote}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

/** Drift: re-find each declared rule by name and diff the generic, common fields (enabled, section, description). */
export async function runRuleDriftDetect<TSpec extends RuleSpec & { name: string; description?: string; enabled: boolean }>(
  ctx: DriftContext,
  config: RuleTypeConfig<TSpec>,
): Promise<DriftResult> {
  const diffs: DriftDiff[] = []
  const built = buildCatoClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }

  const specs = config.extractSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const listed = await listPolicy(built.client, config.policyArea)
  if (!listed.ok) {
    return { hasDrift: true, diffs: [{ field: 'cato', expected: 'reachable', actual: `list failed: ${listed.error}`, severity: 'critical' }] }
  }
  const { rules } = listed.value

  for (const spec of specs) {
    const found = findRuleByName(rules, spec.name)
    if (!found) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }
    if (found.enabled !== spec.enabled) {
      diffs.push({ field: `${spec.name}.enabled`, expected: String(spec.enabled), actual: String(found.enabled), severity: 'warning' })
    }
    const expectedSection = spec.section.trim().toLowerCase()
    const actualSection = (found.section?.name ?? '').trim().toLowerCase()
    if (expectedSection && actualSection && expectedSection !== actualSection) {
      diffs.push({ field: `${spec.name}.section`, expected: spec.section, actual: found.section?.name ?? '', severity: 'warning' })
    }
    const expectedDesc = (spec.description ?? '').trim()
    const actualDesc = (found.description ?? '').trim()
    if (expectedDesc !== actualDesc) {
      diffs.push({ field: `${spec.name}.description`, expected: expectedDesc, actual: actualDesc, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

export { items }
