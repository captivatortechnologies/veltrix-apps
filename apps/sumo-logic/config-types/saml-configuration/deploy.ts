import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, getJson, sendJson } from '../../lib/sumoLogicApi'
import { buildSamlConfigurationBody, findSamlConfiguration, type SamlConfiguration } from './_shared'

/**
 * Deploy Sumo Logic SAML configurations over the Management API (HTTPS).
 * UNLIKE every other list endpoint in this app, GET /saml/identityProviders
 * returns a BARE ARRAY (no `{ data: [...] }` envelope, no pagination):
 *   read (upsert/rollback): GET  /saml/identityProviders            → SamlConfiguration[]
 *   create:                 POST /saml/identityProviders            with a SamlIdentityProviderRequest
 *   update:                 PUT  /saml/identityProviders/<id>        with the same body (id lives in the path)
 *
 * The configuration NAME is the stable identity used to upsert. rollbackData
 * records, per configuration, the prior body (null when it did not exist) AND
 * the configuration id — so rollback can restore the prior body or delete the
 * one we created.
 *
 * ⚠ HIGH BLAST RADIUS: this configures organization-wide sign-in — see the
 * canvas and validate.ts warnings.
 *
 * API: https://www.sumologic.com/help/docs/api/saml-configuration-management/
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for SAML configuration deployment' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  const previous: Array<{ configurationName: string; configId: string | null; config: SamlConfiguration | null }> = []
  const applied: string[] = []

  let live: SamlConfiguration[] = []
  try {
    live = await getJson<SamlConfiguration[]>(`${base}/saml/identityProviders`, headers)
  } catch {
    live = []
  }

  try {
    for (const item of items) {
      const configurationName = String(item.fields.configurationName ?? '').trim()
      if (!configurationName) continue

      const existing = findSamlConfiguration(live, configurationName)
      const body = buildSamlConfigurationBody(item.fields)

      if (existing && existing.id != null) {
        await sendJson('PUT', `${base}/saml/identityProviders/${encodeURIComponent(String(existing.id))}`, headers, body)
        previous.push({ configurationName, configId: String(existing.id), config: existing })
      } else {
        const created = await sendJson<SamlConfiguration>('POST', `${base}/saml/identityProviders`, headers, body)
        previous.push({ configurationName, configId: created?.id != null ? String(created.id) : null, config: null })
      }
      applied.push(configurationName)
    }

    return {
      success: true,
      message: `Applied ${applied.length} SAML configuration(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `SAML configuration deploy failed after ${applied.length} configuration(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
