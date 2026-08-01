import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAxoniusUrl, buildAuthHeaders, apiUrl, getJson, sendJson, verifyTls } from '../../lib/axoniusApi'
import {
  ENFORCEMENTS_LIST_RESOURCE,
  CREATE_ENFORCEMENT_RESOURCE,
  getEnforcementResource,
  updateEnforcementResource,
  enforcementsFromResponse,
  enforcementFromResponse,
  enforcementId,
  findEnforcement,
  buildMainAction,
  buildActions,
  buildCreateBody,
  buildUpdateBody,
  parseText,
  parseJsonObject,
  parseJsonArray,
  type AxoniusEnforcement,
} from './_shared'

/**
 * Deploy Axonius enforcement sets over the REST API (443):
 *   read (rollback): GET  api/enforcements            → find the live set by name
 *   snapshot:        GET  api/enforcements/<uuid>      → prior full definition (updates)
 *   create:          POST api/enforcements             with { data: { type, attributes } }
 *   update:          PUT  api/enforcements/<uuid>      with { data: { type, attributes } }
 *
 * The set name is the stable identity used to upsert. rollbackData records, per
 * set, the prior FULL attributes (null when it did not exist) AND the uuid — so
 * rollback restores the prior definition or deletes the one we created.
 *
 * Verify the JSON:API shapes against a live Axonius tenant.
 */
interface CreateResponse {
  data?: { id?: string; attributes?: { uuid?: string } }
}

interface PriorEntry {
  name: string
  uuid: string | null
  attributes: Record<string, unknown> | null
}

/** Read every live enforcement set (best-effort) for identity matching + rollback. */
async function listEnforcements(
  base: string,
  settings: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<AxoniusEnforcement[]> {
  try {
    return enforcementsFromResponse(
      await getJson<unknown>(apiUrl(base, settings, ENFORCEMENTS_LIST_RESOURCE), headers, { verifyTls: verifyTls(settings) }),
    )
  } catch {
    return []
  }
}

/** GET a set's full definition (name/actions/triggers) so rollback can restore it. */
async function snapshotEnforcement(
  base: string,
  settings: Record<string, unknown>,
  headers: Record<string, string>,
  uuid: string,
): Promise<Record<string, unknown> | null> {
  try {
    const full = enforcementFromResponse(
      await getJson<unknown>(apiUrl(base, settings, getEnforcementResource(uuid)), headers, { verifyTls: verifyTls(settings) }),
    )
    if (!full) return null
    return { name: full.name, actions: full.actions ?? {}, triggers: full.triggers ?? [] }
  } catch {
    return null
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for enforcement-set deployment' }
  }

  const base = buildAxoniusUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeaders(credential)
  if (Object.keys(headers).length !== 2) {
    return { success: false, message: 'Axonius needs an API key (username) and API secret (token) — attach both to this connection.' }
  }
  const opts = { verifyTls: verifyTls(settings) }

  const previous: PriorEntry[] = []
  const applied: string[] = []

  try {
    const live = await listEnforcements(base, settings, headers)

    for (const item of items) {
      const name = parseText(item.fields.name)
      if (!name) continue
      const actionName = parseText(item.fields.action_name)
      const actionLabel = parseText(item.fields.action_label) || name
      const config = parseJsonObject(item.fields.config)
      if (!config.ok) throw new Error(`Enforcement set "${name}" has an invalid action config: ${config.error}`)
      const triggers = parseJsonArray(item.fields.triggers)
      if (!triggers.ok) throw new Error(`Enforcement set "${name}" has invalid triggers: ${triggers.error}`)

      const actions = buildActions(buildMainAction(actionLabel, actionName, config.value))

      const existing = findEnforcement(live, name)
      const existingId = enforcementId(existing)

      if (existing && existingId) {
        const prior = await snapshotEnforcement(base, settings, headers, existingId)
        await sendJson(
          'PUT',
          apiUrl(base, settings, updateEnforcementResource(existingId)),
          headers,
          buildUpdateBody({ uuid: existingId, name, actions, triggers: triggers.value }),
          opts,
        )
        previous.push({ name, uuid: existingId, attributes: prior })
      } else {
        const created = await sendJson<CreateResponse>(
          'POST',
          apiUrl(base, settings, CREATE_ENFORCEMENT_RESOURCE),
          headers,
          buildCreateBody({ name, actions, triggers: triggers.value, description: parseText(item.fields.description) }),
          opts,
        )
        previous.push({ name, uuid: created?.data?.attributes?.uuid ?? created?.data?.id ?? null, attributes: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} enforcement set${applied.length === 1 ? '' : 's'}: ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Enforcement-set deploy failed after ${applied.length} set${applied.length === 1 ? '' : 's'}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
