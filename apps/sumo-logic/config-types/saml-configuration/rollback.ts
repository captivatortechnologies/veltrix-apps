import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, sendJson } from '../../lib/sumoLogicApi'
import type { SamlConfiguration } from './_shared'

/**
 * Undo a saml-configuration deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT /saml/identityProviders/<id> with the prior
 * body (restore), or — when the configuration was newly created (prior body
 * null) — DELETE /saml/identityProviders/<id> to remove it. Applied over the
 * Sumo Logic Management API.
 *
 * ⚠ HIGH BLAST RADIUS: restoring or removing a SAML configuration changes
 * organization-wide sign-in immediately for every user of that IdP.
 *
 * API: https://www.sumologic.com/help/docs/api/saml-configuration-management/
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ configurationName: string; configId: string | null; config: SamlConfiguration | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for SAML configuration rollback' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { configId, config } of previous) {
      if (configId == null) {
        // A created configuration whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      const path = `${base}/saml/identityProviders/${encodeURIComponent(configId)}`
      if (config) {
        const { id: _id, assertionConsumerUrl: _a, entityId: _e, ...body } = config
        await sendJson('PUT', path, headers, body)
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back SAML configurations: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
