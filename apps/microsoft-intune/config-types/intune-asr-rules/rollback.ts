import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage } from '../../lib/intune'
import { ASR_TEMPLATE_FAMILY, ASR_TEMPLATE_ID } from '../../lib/asr'
import type { AsrRollbackEntry } from './deploy'

/**
 * Roll back ASR policies using the state captured during deploy: policies this
 * deploy created are deleted; policies it updated are restored to their prior
 * name/description/settings.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AsrRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/deviceManagement/configurationPolicies/${entry.id}`)
          if (res.status !== 404 && !res.ok) throw new Error(`Failed to delete ASR policy "${entry.name}": ${graphErrorMessage(res)}`)
        }
      } else if (entry.id && entry.prior) {
        const body = {
          name: entry.prior.name ?? entry.name,
          description: entry.prior.description ?? '',
          platforms: 'windows10',
          technologies: 'mdm,microsoftSense',
          roleScopeTagIds: ['0'],
          templateReference: {
            '@odata.type': '#microsoft.graph.deviceManagementConfigurationPolicyTemplateReference',
            templateId: ASR_TEMPLATE_ID,
            templateFamily: ASR_TEMPLATE_FAMILY,
          },
          settings: entry.prior.settings ?? [],
        }
        const res = await client.request('PATCH', `/deviceManagement/configurationPolicies/${entry.id}`, { body })
        if (!res.ok) throw new Error(`Failed to restore ASR policy "${entry.name}": ${graphErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }
    return { success: true, message: `Rolled back ${reverted.length} ASR policy(ies): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
