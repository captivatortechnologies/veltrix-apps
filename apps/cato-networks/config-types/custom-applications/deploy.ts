import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildCatoClient, responseError } from '../../lib/cato'
import { ADD_CUSTOM_APPLICATION, UPDATE_CUSTOM_APPLICATION, customApplicationsFromList, findCustomApplication, LIST_CUSTOM_APPLICATIONS } from './_shared'
import { buildCustomApplicationInput, extractCustomApplicationSpecs, type CustomApplicationSpec } from './validate'

export interface CustomApplicationRollbackEntry {
  name: string
  existed: boolean
  id?: string
  priorSpec?: CustomApplicationSpec
}

/**
 * Deploy Custom Applications. Identity is the NAME (no upsert): list
 * customApplicationList, match by name, then updateCustomApplication (id
 * required) or addCustomApplication. Applies IMMEDIATELY - there is no
 * publish/revision step for this object (unlike the firewall/CASB/TLS
 * inspection policy types).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCatoClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, accountId } = built

  const specs = extractCustomApplicationSpecs(ctx.canvas).filter((s) => s.name)
  const previousSpecs = ctx.previousConfig ? extractCustomApplicationSpecs(ctx.previousConfig) : []
  const previousByName = new Map(previousSpecs.map((s) => [s.name.trim().toLowerCase(), s]))

  const rollbackState: CustomApplicationRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const listRes = await client.graphql(LIST_CUSTOM_APPLICATIONS, { accountId })
    const listErr = responseError(listRes)
    if (listErr) throw new Error(`Failed to list Custom Applications: ${listErr}`)
    const live = customApplicationsFromList(listRes.data)

    for (const spec of specs) {
      const existing = findCustomApplication(live, spec.name)
      const input = buildCustomApplicationInput(spec)

      if (existing) {
        const res = await client.graphql(UPDATE_CUSTOM_APPLICATION, { accountId, input: { ...input, id: existing.id } })
        const err = responseError(res)
        if (err) throw new Error(`Failed to update Custom Application "${spec.name}": ${err}`)
        rollbackState.push({ name: spec.name, existed: true, id: existing.id, priorSpec: previousByName.get(spec.name.trim().toLowerCase()) })
      } else {
        const res = await client.graphql(ADD_CUSTOM_APPLICATION, { accountId, input })
        const err = responseError(res)
        if (err) throw new Error(`Failed to create Custom Application "${spec.name}": ${err}`)
        const createdId = (res.data as any)?.customAppData?.addCustomApplication?.customApplication?.id
        if (!createdId) throw new Error(`Custom Application "${spec.name}" was created but the API returned no id`)
        rollbackState.push({ name: spec.name, existed: false, id: createdId })
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Custom Application(s) on Cato account ${accountId}: ${deployed.join(', ')}`,
      artifacts: { accountId, deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Custom Application deployment failed after ${deployed.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { accountId, deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}
