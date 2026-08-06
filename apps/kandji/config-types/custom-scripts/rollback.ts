import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildKandjiClient } from '../../lib/kandjiApi'
import { buildCustomScriptBody, type CustomScriptSpec, type LiveCustomScript } from './validate'
import type { CustomScriptRollbackEntry } from './deploy'

const CUSTOM_SCRIPTS_PATH = '/api/v1/library/custom-scripts'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildKandjiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: CustomScriptRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `${CUSTOM_SCRIPTS_PATH}/${encodeURIComponent(entry.id)}`)
          if (res.error) throw new Error(`Failed to delete Custom Script "${entry.label}": ${res.error}`)
        }
      } else if (entry.id && entry.prior) {
        const res = await client.request('PATCH', `${CUSTOM_SCRIPTS_PATH}/${encodeURIComponent(entry.id)}`, {
          body: priorToBody(entry.prior),
        })
        if (res.error) throw new Error(`Failed to restore Custom Script "${entry.label}": ${res.error}`)
      }
      reverted.push(entry.label)
    }
    return { success: true, message: `Rolled back ${reverted.length} Kandji Custom Script(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

function priorToBody(prior: LiveCustomScript): Record<string, unknown> {
  const spec: CustomScriptSpec = {
    sectionName: '',
    name: prior.name ?? '',
    executionFrequency: prior.execution_frequency ?? 'no_enforcement',
    active: prior.active ?? true,
    restart: prior.restart ?? false,
    script: prior.script ?? '',
    remediationScript: prior.remediation_script ?? '',
    showInSelfService: prior.show_in_self_service ?? false,
    selfServiceCategoryId: prior.self_service_category_id ?? '',
    selfServiceRecommended: prior.self_service_recommended ?? false,
  }
  return buildCustomScriptBody(spec)
}
