import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, getJson, sendJson, coerceList, MISSING_CREDENTIAL_MESSAGE } from '../../lib/runzeroApi'
import { buildCustomIntegrationBody, findCustomIntegration, text, type RunzeroCustomIntegration, type CustomIntegrationRollbackEntry } from './_shared'

/**
 * Deploy runZero Custom Integrations over the console REST API:
 *   read (identity): GET   /account/custom-integrations         → find the live integration by name
 *   create:          POST  /account/custom-integrations         with CustomIntegrationCreate
 *   update:          PATCH /account/custom-integrations/{id}    with BaseCustomIntegration (integration exists)
 *
 * ACCOUNT-scoped: requires an account-scoped runZero API key (see _shared header). The name is the
 * stable identity used to upsert. rollbackData records, per integration, whether it already
 * existed, its id, and its prior body — so rollback can restore an update or delete a create.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!resolveRunzeroToken(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const base = buildRunzeroUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const timeoutMs = timeoutFrom(settings)

  const previous: CustomIntegrationRollbackEntry[] = []
  const applied: string[] = []

  try {
    const live = coerceList<RunzeroCustomIntegration>(await getJson<unknown>(`${base}/account/custom-integrations`, headers, timeoutMs))

    for (const item of items) {
      const body = buildCustomIntegrationBody(item.fields)
      const name = text(body.name)
      if (!name) continue

      const existing = findCustomIntegration(live, name)

      if (existing && existing.id) {
        await sendJson('PATCH', `${base}/account/custom-integrations/${encodeURIComponent(existing.id)}`, headers, body, timeoutMs)
        previous.push({ name, integrationId: existing.id, existed: true, prior: existing })
      } else {
        const created = await sendJson<RunzeroCustomIntegration>('POST', `${base}/account/custom-integrations`, headers, body, timeoutMs)
        previous.push({ name, integrationId: created?.id ?? null, existed: false, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} custom integration(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Custom integration deploy failed after ${applied.length} integration(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}

/** Resolve the per-request timeout (ms) from the app setting, defaulting to the client default. */
function timeoutFrom(settings: Record<string, unknown>): number | undefined {
  const raw = settings?.request_timeout_seconds
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw * 1000 : undefined
}
