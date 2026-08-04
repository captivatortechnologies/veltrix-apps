import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildImpervaClient,
  fetchSiteStatus,
  SITE_CONFIGURE_PATH,
  SITE_LOG_LEVEL_PATH,
  isApiSuccess,
  apiMessage,
  parseJson,
  type ImpervaClient,
  type ImpervaEnvelope,
} from '../../lib/impervaApi'
import { declaredConfigureParams, liveSiteConfigValues, READABLE_FIELDS, readSiteConfigFields, SITE_CONFIGURE_PARAM_NAMES } from './_shared'

/**
 * Deploy Imperva Cloud WAF site general configuration. A site's settings are a
 * SINGLETON, SET declaratively — one `POST /sites/configure { site_id, param,
 * value }` call PER declared param (the v1 API takes one param/value pair per
 * request), plus `POST /sites/setlog { site_id, log_level, logs_account_id }`
 * when a log level is declared.
 *
 * `rollbackData.previous` records, per site, the prior value of every READABLE
 * field (see ./_shared) read from `POST /sites/status` BEFORE the change — the
 * remaining fields (domain_validation, approver, ignore_ssl,
 * domain_redirect_to_full) have no read-back on this API and are write-only:
 * rollback cannot restore them, matching this app's existing precedent for
 * write-only fields (e.g. ACL Rules' filter, Meraki's syslogDefaultRule).
 */

interface PriorEntry {
  siteId: string
  prior: Record<string, string>
  declaredWriteOnly: string[]
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  const built = buildImpervaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: PriorEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const fields = readSiteConfigFields(item.fields)
      if (!fields.siteId) continue

      const priorStatus = await fetchSiteStatus(client, fields.siteId)
      const prior = liveSiteConfigValues(priorStatus)
      const declaredWriteOnly = Object.keys(SITE_CONFIGURE_PARAM_NAMES).filter(
        (key) => !READABLE_FIELDS.has(key) && (fields as unknown as Record<string, string>)[key] !== '',
      )
      previous.push({ siteId: fields.siteId, prior, declaredWriteOnly })

      let changeCount = 0
      for (const { param, value } of declaredConfigureParams(fields)) {
        await configureSite(client, fields.siteId, param, value)
        changeCount++
      }
      if (fields.logLevel) {
        await setLogLevel(client, fields.siteId, fields.logLevel, fields.logsAccountId)
        changeCount++
      }

      applied.push(`site ${fields.siteId} (${changeCount} setting${changeCount === 1 ? '' : 's'})`)
    }

    return {
      success: true,
      message: `Applied site configuration for ${applied.length} site(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Site configuration deploy failed after ${applied.length} site(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}

async function configureSite(client: ImpervaClient, siteId: string, param: string, value: string): Promise<void> {
  const res = await client.post(SITE_CONFIGURE_PATH, { site_id: siteId, param, value })
  const json = parseJson<ImpervaEnvelope>(res.body)
  if (!res.ok || !isApiSuccess(json)) throw new Error(`set ${param}=${value} (site ${siteId}) → HTTP ${res.status}: ${apiMessage(json)}`)
}

async function setLogLevel(client: ImpervaClient, siteId: string, logLevel: string, logsAccountId: string): Promise<void> {
  const params: Record<string, string> = { site_id: siteId, log_level: logLevel }
  if (logsAccountId) params.logs_account_id = logsAccountId
  const res = await client.post(SITE_LOG_LEVEL_PATH, params)
  const json = parseJson<ImpervaEnvelope>(res.body)
  if (!res.ok || !isApiSuccess(json)) throw new Error(`set log_level=${logLevel} (site ${siteId}) → HTTP ${res.status}: ${apiMessage(json)}`)
}
