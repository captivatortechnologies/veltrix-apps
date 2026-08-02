import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { rubrikConnect, getJson, sendJson, MISSING_CREDENTIAL_MESSAGE, resolveServiceAccount } from '../../lib/rubrikApi'
import {
  buildFilesetTemplateBody,
  filesetTemplatesFromList,
  findTemplateByName,
  normalizeName,
  type RubrikFilesetTemplate,
} from './_shared'

/**
 * Deploy Rubrik fileset templates over the CDM v1 REST API:
 *   read (rollback): GET   /api/v1/fileset_template     -> find the live template by name
 *   create:          POST  /api/v1/fileset_template      with the template body
 *   update:          PATCH /api/v1/fileset_template/{id} with the template body (exists)
 *
 * The template name is the stable identity used to upsert. rollbackData records,
 * per template, whether it existed, its id, and the prior body — so rollback can
 * restore the prior definition or delete the one we created.
 *
 * FLAG: verify the /api/v1/fileset_template create/patch body shape against a live
 * Rubrik CDM cluster.
 */
interface RollbackEntry {
  name: string
  existed: boolean
  id: string | null
  prior: RubrikFilesetTemplate | null
}

/** Read every live fileset template (best-effort) for identity matching + snapshots. */
async function listTemplates(conn: Awaited<ReturnType<typeof rubrikConnect>>): Promise<RubrikFilesetTemplate[]> {
  try {
    return filesetTemplatesFromList(await getJson<unknown>(conn, '/api/v1/fileset_template'))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!resolveServiceAccount(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  let conn
  try {
    conn = await rubrikConnect(component, credential, settings)
  } catch (error) {
    return { success: false, message: `Rubrik connection failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  try {
    const live = await listTemplates(conn)

    for (const item of items) {
      const name = normalizeName(item.fields.name)
      if (!name) continue

      const existing = findTemplateByName(live, name)
      const body = buildFilesetTemplateBody(item.fields)

      if (existing && existing.id) {
        await sendJson(conn, 'PATCH', `/api/v1/fileset_template/${encodeURIComponent(existing.id)}`, body)
        previous.push({ name, existed: true, id: existing.id, prior: existing })
      } else {
        const created = await sendJson<RubrikFilesetTemplate>(conn, 'POST', '/api/v1/fileset_template', body)
        previous.push({ name, existed: false, id: created?.id ?? null, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} fileset template(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { base: conn.base, applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Fileset template deploy failed after ${applied.length} of ${items.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { base: conn.base, applied },
      rollbackData: { previous },
    }
  }
}
