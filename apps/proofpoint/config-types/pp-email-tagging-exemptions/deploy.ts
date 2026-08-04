import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPPClient, ppErrorMessage } from '../../lib/proofpoint'
import { extractExemptionSpecs, getExemptions, senderKey } from './validate'

export interface ExemptionRollbackData {
  added: string[]
}

/**
 * Deploy Proofpoint Essentials email-tagging exemptions via the dedicated
 * exemptions resource (POST /orgs/{org}/email-tagging/exemptions, additive).
 *
 * Reads the org's current exempt-sender list, then POSTs only the declared
 * senders missing from it (never re-submits already-exempt senders). Senders
 * exempted outside this deploy are left untouched. The set this deploy added is
 * captured so rollback can remove exactly those.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl, orgDomain } = built

  const specs = extractExemptionSpecs(ctx.canvas).filter((s) => s.sender)

  try {
    const current = await getExemptions(client)
    const currentKeys = new Set(current.map(senderKey))

    const added: string[] = []
    for (const spec of specs) {
      const key = senderKey(spec.sender)
      if (!currentKeys.has(key)) {
        added.push(spec.sender)
        currentKeys.add(key)
      }
    }

    if (added.length > 0) {
      const res = await client.request('POST', `${client.orgPath}/email-tagging/exemptions`, { body: { exemptions: added } })
      if (!res.ok) throw new Error(`Failed to add email-tagging exemptions: ${ppErrorMessage(res)}`)
    }

    return {
      success: true,
      message: `Deployed ${specs.length} email-tagging exemption(s) to Proofpoint Essentials org "${orgDomain}" (${added.length} newly added).`,
      artifacts: { baseUrl, orgDomain, added },
      rollbackData: { added } satisfies ExemptionRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Email-tagging exemption deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { baseUrl, orgDomain },
      rollbackData: { added: [] } satisfies ExemptionRollbackData,
    }
  }
}
