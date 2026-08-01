import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTaniumBaseUrl, resolveTaniumSession } from '../../lib/taniumApi'
import { upsertEntity, type UpsertRecord } from '../../lib/taniumRestEntity'
import { PACKAGES_RESOURCE, buildPackageBody, type TaniumPackage } from './_shared'

/**
 * Deploy Tanium packages over the REST v2 API (443). The name is the stable
 * identity used to upsert:
 *   lookup: GET    /api/v2/packages/by-name/{name}
 *   update: DELETE /api/v2/packages/{id} then POST /api/v2/packages
 *   create: POST   /api/v2/packages            with { name, command, ... }
 *
 * REST v2 exposes no confirmed in-place update for packages, so an existing one is
 * replaced (delete + recreate) — this churns the object id, which may break saved
 * actions that reference the package by id. Verify against a live Tanium.
 * rollbackData records, per item, the prior object (null when new) and the created id.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for package deployment' }
  }

  const base = buildTaniumBaseUrl(component, connectivity, connectivityProvider)
  const previous: Array<UpsertRecord<TaniumPackage>> = []
  const applied: string[] = []

  try {
    const session = await resolveTaniumSession(base, credential)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const body = buildPackageBody(item.fields)
      previous.push(await upsertEntity<TaniumPackage>(base, session, PACKAGES_RESOURCE, name, body))
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} package(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Package deploy failed after ${applied.length} package(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
