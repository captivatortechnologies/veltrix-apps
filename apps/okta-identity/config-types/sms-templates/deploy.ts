import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  buildSmsTemplateBody,
  extractSmsTemplateSpecs,
  parseTranslations,
  stripReadOnlySmsFields,
  type LiveSmsTemplate,
} from './validate'

export interface SmsTemplateRollbackEntry {
  name: string
  existed: boolean
  /** The template id Okta assigns — the rollback key (never the name). */
  id?: string
  /** Prior template body with server-managed readOnly fields stripped, replayed via PUT on rollback. */
  prior?: Record<string, unknown>
}

/**
 * Deploy custom SMS templates to an Okta org via the Templates API. There is NO
 * upsert, so for each declared template:
 *   - GET  /templates/sms         — list and match by name
 *   - PUT  /templates/sms/{id}    — full-replace an existing template (capture prior body)
 *   - POST /templates/sms         — create a missing template (capture the new id)
 * There is no lifecycle/status: unlike a network zone, a template is simply
 * created, replaced or deleted.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractSmsTemplateSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: SmsTemplateRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      // Re-parse here to build the API body and to fail loudly rather than send a
      // malformed translations blob. An absent blob is treated as no translations.
      const translations = spec.translationsJson ? parseTranslations(spec.translationsJson) : {}
      if (translations === null) {
        throw new Error(`SMS template "${spec.name}": translations is not a valid JSON object of strings`)
      }

      const existing = await findSmsTemplate(client, spec.name)

      if (existing && existing.id) {
        // FULL REPLACE via PUT — capture the prior body (stripped of readOnly
        // fields) for rollback, keyed on the returned id, never the name.
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: stripReadOnlySmsFields(existing),
        })

        const res = await client.request('PUT', `/templates/sms/${existing.id}`, {
          body: buildSmsTemplateBody(spec, translations),
        })
        if (!res.ok) {
          throw new Error(`Failed to update SMS template "${spec.name}": ${oktaErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/templates/sms', {
          body: buildSmsTemplateBody(spec, translations),
        })
        if (!res.ok) {
          throw new Error(`Failed to create SMS template "${spec.name}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LiveSmsTemplate>(res.body)
        if (!created?.id) {
          throw new Error(`SMS template "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} SMS template(s) to Okta org at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedTemplates: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `SMS template deployment failed after ${deployed.length} of ${specs.length} template(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedTemplates: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** Find a template by exact name across the paginated template list; null when absent. */
export async function findSmsTemplate(client: OktaClient, name: string): Promise<LiveSmsTemplate | null> {
  const res = await client.getAll<LiveSmsTemplate>('/templates/sms')
  if (!res.ok) {
    throw new Error(
      `Failed to list SMS templates while resolving "${name}": ${oktaErrorMessage({
        status: res.status,
        ok: res.ok,
        body: res.body,
        nextUrl: null,
      })}`,
    )
  }
  return res.items.find((t) => t.name === name) ?? null
}

/** Fetch a single template by id; null on 404. */
export async function getSmsTemplateById(client: OktaClient, id: string): Promise<LiveSmsTemplate | null> {
  const res = await client.request('GET', `/templates/sms/${id}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to fetch SMS template ${id}: ${oktaErrorMessage(res)}`)
  }
  return parseJson<LiveSmsTemplate>(res.body)
}
