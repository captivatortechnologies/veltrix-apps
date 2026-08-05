// =============================================================================
// Generic deploy/rollback/driftDetect engine shared by every Cato SECTION-based
// configuration type (Internet Firewall, WAN Firewall). Sections group and
// order a policy's rules; see catoPolicy.ts for the staged publish/revert
// model and the `PolicyAddSectionInput` / `PolicyUpdateSectionInput` /
// `PolicyRemoveSectionInput` / `PolicyMoveSectionInput` mutations (shared,
// generic input types across every policy area - verified against
// cato_api.graphqls).
// =============================================================================

import type { CanvasSnapshot, DeployContext, DeployResult, DriftContext, DriftDiff, DriftResult, RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCatoClient } from '../../lib/cato'
import {
  extractEnvelope,
  items,
  listPolicy,
  moveSectionDoc,
  publishPolicy,
  resolveSectionPosition,
  sectionMutationDoc,
  unwrapSection,
  withPolicyRevisionConflictRetry,
  type PolicySectionRef,
  type SectionPosition,
} from './catoPolicy'

export interface SectionSpec {
  name: string
  position: SectionPosition
  positionSectionName?: string
}

export interface SectionTypeConfig<TSpec extends SectionSpec> {
  policyArea: string
  typeLabel: string
  extractSpecs: (canvas: CanvasSnapshot) => TSpec[]
}

export interface SectionRollbackEntry<TSpec extends SectionSpec> {
  name: string
  existed: boolean
  id?: string
  priorSpec?: TSpec
}

function findSectionByName(sections: PolicySectionRef[], name: string): PolicySectionRef | null {
  const key = name.trim().toLowerCase()
  return sections.find((s) => s.name.trim().toLowerCase() === key) ?? null
}

export async function runSectionDeploy<TSpec extends SectionSpec>(ctx: DeployContext, config: SectionTypeConfig<TSpec>): Promise<DeployResult> {
  const built = buildCatoClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, accountId } = built

  const specs = config.extractSpecs(ctx.canvas).filter((s) => s.name)
  const previousSpecs = ctx.previousConfig ? config.extractSpecs(ctx.previousConfig) : []
  const previousByName = new Map(previousSpecs.map((s) => [s.name.trim().toLowerCase(), s]))

  const rollbackState: SectionRollbackEntry<TSpec>[] = []
  const deployed: string[] = []

  try {
    const listed = await listPolicy(client, config.policyArea)
    if (!listed.ok) throw new Error(`Failed to read ${config.typeLabel} policy: ${listed.error}`)
    let sections = listed.value.sections

    for (const spec of specs) {
      const existing = findSectionByName(sections, spec.name)
      let sectionId: string

      if (existing) {
        const res = await client.graphql(sectionMutationDoc(config.policyArea, 'updateSection', 'PolicyUpdateSectionInput!'), {
          accountId,
          input: { id: existing.id, section: { name: spec.name } },
        })
        if (res.transportError) throw new Error(`Failed to update ${config.typeLabel} "${spec.name}": ${res.transportError}`)
        const env = extractEnvelope(res.data, config.policyArea, 'updateSection', unwrapSection)
        if (env.status !== 'SUCCESS') {
          throw new Error(`Failed to update ${config.typeLabel} "${spec.name}": ${env.errors.map((e) => e.errorMessage || e.errorCode).join('; ')}`)
        }
        sectionId = existing.id
        rollbackState.push({ name: spec.name, existed: true, id: sectionId, priorSpec: previousByName.get(spec.name.trim().toLowerCase()) })
      } else {
        const siblingId = spec.positionSectionName ? findSectionByName(sections, spec.positionSectionName)?.id ?? null : null
        const at = resolveSectionPosition(spec.position, siblingId)
        const res = await client.graphql(sectionMutationDoc(config.policyArea, 'addSection', 'PolicyAddSectionInput!'), {
          accountId,
          input: { at, section: { name: spec.name } },
        })
        if (res.transportError) throw new Error(`Failed to create ${config.typeLabel} "${spec.name}": ${res.transportError}`)
        const env = extractEnvelope(res.data, config.policyArea, 'addSection', unwrapSection)
        if (env.status !== 'SUCCESS' || !env.node) {
          throw new Error(`Failed to create ${config.typeLabel} "${spec.name}": ${env.errors.map((e) => e.errorMessage || e.errorCode).join('; ')}`)
        }
        sectionId = env.node.id
        rollbackState.push({ name: spec.name, existed: false, id: sectionId })
        sections = [...sections, env.node]
      }

      if (existing) {
        const siblingId = spec.positionSectionName ? findSectionByName(sections, spec.positionSectionName)?.id ?? null : null
        const to = resolveSectionPosition(spec.position, siblingId)
        const moveRes = await client.graphql(moveSectionDoc(config.policyArea), { accountId, input: { id: sectionId, to } })
        if (moveRes.transportError) throw new Error(`Failed to position ${config.typeLabel} "${spec.name}": ${moveRes.transportError}`)
        const moveEnv = extractEnvelope(moveRes.data, config.policyArea, 'moveSection', () => null)
        if (moveEnv.status !== 'SUCCESS') {
          throw new Error(`Failed to position ${config.typeLabel} "${spec.name}": ${moveEnv.errors.map((e) => e.errorMessage || e.errorCode).join('; ')}`)
        }
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

export async function runSectionRollback<TSpec extends SectionSpec>(ctx: RollbackContext, config: SectionTypeConfig<TSpec>): Promise<RollbackResult> {
  const built = buildCatoClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, accountId } = built

  const previousState = (ctx.rollbackData as { previousState?: SectionRollbackEntry<TSpec>[] } | null)?.previousState
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
          const res = await client.graphql(sectionMutationDoc(config.policyArea, 'removeSection', 'PolicyRemoveSectionInput!'), {
            accountId,
            input: { id: entry.id },
          })
          if (res.transportError) throw new Error(`Failed to delete "${entry.name}": ${res.transportError}`)
          const env = extractEnvelope(res.data, config.policyArea, 'removeSection', unwrapSection)
          if (env.status !== 'SUCCESS') {
            throw new Error(`Failed to delete "${entry.name}": ${env.errors.map((e) => e.errorMessage || e.errorCode).join('; ')}`)
          }
          deleted.push(entry.name)
        }
      } else if (entry.id && entry.priorSpec) {
        const res = await client.graphql(sectionMutationDoc(config.policyArea, 'updateSection', 'PolicyUpdateSectionInput!'), {
          accountId,
          input: { id: entry.id, section: { name: entry.priorSpec.name } },
        })
        if (res.transportError) throw new Error(`Failed to restore "${entry.name}": ${res.transportError}`)
        const env = extractEnvelope(res.data, config.policyArea, 'updateSection', unwrapSection)
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

export async function runSectionDriftDetect<TSpec extends SectionSpec & { name: string }>(
  ctx: DriftContext,
  config: SectionTypeConfig<TSpec>,
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

  for (const spec of specs) {
    const found = findSectionByName(listed.value.sections, spec.name)
    if (!found) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

export { items }
