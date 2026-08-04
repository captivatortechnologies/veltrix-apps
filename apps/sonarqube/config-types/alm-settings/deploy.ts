import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson, postForm } from '../../lib/sonarqubeApi'
import { ALM_TYPES, definitionsFromListResponse, createAction, updateAction, createParams, updateParams, type SettingFields } from './_shared'

/**
 * Deploy SonarQube ALM settings over the Web API (/api/alm_settings):
 *   list (context):  GET  /api/alm_settings/list_definitions → find each setting by key
 *   create:          POST /api/alm_settings/create_<almType> (key absent)
 *   update:          POST /api/alm_settings/update_<almType> (key present, same almType)
 *
 * The setting `key` is the identity used to upsert (SonarQube enforces global uniqueness).
 * SonarQube has no in-place "change the ALM type of an existing key" API, and a delete +
 * recreate would permanently lose secrets this app never captured — so a key whose live
 * almType differs from the declared one FAILS THAT ITEM rather than taking a destructive,
 * irreversible shortcut. Processing continues for the remaining items; the deploy as a
 * whole is reported failed if any item failed (type-change conflict, or a live API error),
 * with a per-key breakdown of what succeeded and what didn't.
 *
 * rollbackData records, per successfully-applied item, whether it existed and the prior
 * non-secret identity fields (almType, url, appId, clientId, workspace) — never a secret,
 * since SonarQube never returns one — so rollback can restore them or delete a setting we
 * created.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for ALM settings deployment' }
  }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live: ReturnType<typeof definitionsFromListResponse>
  try {
    live = definitionsFromListResponse(await getJson<unknown>(`${base}/api/alm_settings/list_definitions`, headers))
  } catch (error) {
    return { success: false, message: `Could not read existing ALM settings: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  const settings: Array<{
    key: string
    existed: boolean
    priorAlmType?: string
    priorUrl?: string
    priorAppId?: string
    priorClientId?: string
    priorWorkspace?: string
  }> = []
  const applied: string[] = []
  const failed: string[] = []

  for (const item of items) {
    const key = String(item.fields.key ?? '').trim()
    const almType = String(item.fields.almType ?? '').trim()
    if (!key || !almType || !ALM_TYPES.has(almType)) continue

    const existing = live.get(key)
    const existed = existing !== undefined

    if (existed && existing!.almType !== almType) {
      failed.push(`${key}: cannot change ALM type of existing key "${key}" from ${existing!.almType} to ${almType} — delete it in SonarQube first`)
      continue
    }

    const fields: SettingFields = {
      key,
      url: String(item.fields.url ?? '').trim(),
      personalAccessToken: String(item.fields.personalAccessToken ?? '').trim(),
      appId: String(item.fields.appId ?? '').trim(),
      clientId: String(item.fields.clientId ?? '').trim(),
      clientSecret: String(item.fields.clientSecret ?? '').trim(),
      privateKey: String(item.fields.privateKey ?? '').trim(),
      webhookSecret: String(item.fields.webhookSecret ?? '').trim(),
      workspace: String(item.fields.workspace ?? '').trim(),
    }

    try {
      if (!existed) {
        await postForm(`${base}/api/alm_settings/${createAction(almType)}`, headers, createParams(almType, fields))
      } else {
        await postForm(`${base}/api/alm_settings/${updateAction(almType)}`, headers, updateParams(almType, fields))
      }

      settings.push({
        key,
        existed,
        priorAlmType: existing?.almType,
        priorUrl: existing?.url,
        priorAppId: existing?.appId,
        priorClientId: existing?.clientId,
        priorWorkspace: existing?.workspace,
      })
      applied.push(`${key} (${almType})`)
    } catch (error) {
      failed.push(`${key}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  const message =
    failed.length === 0
      ? `Applied ${applied.length} ALM setting(s): ${applied.join(', ') || '(none)'}`
      : `Applied ${applied.length} ALM setting(s)${applied.length ? ` (${applied.join(', ')})` : ''}; failed ${failed.length}: ${failed.join('; ')}`

  return {
    success: failed.length === 0,
    message,
    artifacts: { applied },
    rollbackData: { settings },
  }
}
