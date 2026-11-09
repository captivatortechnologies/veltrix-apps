import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { compilePack } from '../../lib/compiler'
import { getPolicyAccount, getPolicyByName, listActiveExceptions, upsertPolicyAccount } from '../../lib/db'
import type { PolicyDto } from '../../lib/db'
import { validatePack } from '../../lib/model'
import type { GovernancePolicy, PolicyException } from '../../lib/model/types'
import { readPackItem } from '../lib/packItem'
import { itemsOf } from '../lib/readers'
import { errorMessage, toPolicyException } from '../lib/results'
import { resolveStore, STORE_UNAVAILABLE } from '../lib/store'
import type { PackRollbackData, PackRollbackEntry } from './_shared'

/**
 * A pack is not a stored entity: the store has no pack table and a pack must
 * not be faked as a policy row. Deploying a pack therefore registers each
 * MEMBER policy for this account and returns the compiled pack document in
 * artifacts.compiledYaml (keyed by pack name) for audit. Regions already set on
 * a member's account link are preserved.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const store = resolveStore(ctx)
  if (!store) return { success: false, message: STORE_UNAVAILABLE }

  const now = new Date()
  const entries: PackRollbackEntry[] = []
  const deployed: Array<{ name: string; members: string[]; actionClass: string }> = []
  const compiledYaml: Record<string, string> = {}
  const failures: string[] = []
  const warnings: string[] = []

  try {
    for (const canvasItem of itemsOf(ctx.canvas)) {
      const { value: pack, errors } = validatePack(readPackItem(canvasItem))
      if (!pack) {
        failures.push(`${canvasItem.name}: ${errors.map((e) => e.message).join('; ')}`)
        continue
      }

      const members: PolicyDto[] = []
      const missing: string[] = []
      for (const name of pack.policies) {
        const policy = await getPolicyByName(store.db, store.customerId, name)
        if (policy) members.push(policy)
        else missing.push(name)
      }
      if (missing.length > 0) {
        failures.push(`${pack.name}: member policy(ies) not found: ${missing.join(', ')}`)
        continue
      }

      const exceptions: PolicyException[] = []
      for (const member of members) {
        exceptions.push(...(await listActiveExceptions(store.db, store.customerId, member.name, now)).map(toPolicyException))
      }
      const byName: Record<string, GovernancePolicy> = Object.fromEntries(members.map((m) => [m.name, m.model]))
      const compiled = compilePack(pack, byName, { exceptions, now })
      if (!compiled.ok || compiled.yaml === null) {
        failures.push(`${pack.name}: ${compiled.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`)
        continue
      }

      const entry: PackRollbackEntry = { name: pack.name, members: [] }
      for (const member of members) {
        const link = await getPolicyAccount(store.db, store.customerId, member.id, ctx.component.id)
        await upsertPolicyAccount(store.db, store.customerId, {
          policyId: member.id,
          componentId: ctx.component.id,
          accountRef: ctx.component.hostname,
          regions: link?.regions ?? [],
        })
        entry.members.push({ policyName: member.name, policyId: member.id, wasLinked: link !== null })
      }
      entries.push(entry)
      compiledYaml[pack.name] = compiled.yaml
      deployed.push({ name: pack.name, members: pack.policies, actionClass: compiled.actionClass })
      warnings.push(...compiled.warnings.map((w) => `${pack.name}: ${w.message}`))
    }
  } catch (error) {
    failures.push(`Store error: ${errorMessage(error)}`)
  }

  const rollbackData: PackRollbackData = { componentId: ctx.component.id, packs: entries }
  return {
    success: failures.length === 0,
    message:
      failures.length === 0
        ? `Registered ${deployed.length} pack(s) for ${ctx.component.hostname}: ${deployed.map((d) => d.name).join(', ') || '(none)'}`
        : `Pack deploy had ${failures.length} failure(s): ${failures.join(' | ')}`,
    artifacts: { deployed, compiledYaml, failures, warnings },
    rollbackData,
  }
}
