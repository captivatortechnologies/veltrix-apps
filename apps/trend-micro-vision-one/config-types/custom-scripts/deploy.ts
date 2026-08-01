import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVisionOneClient, visionOneWriteError, type VisionOneClient } from '../../lib/visionOneApi'
import {
  CUSTOM_SCRIPT_ADD,
  CUSTOM_SCRIPT_LIST,
  findScriptByFileName,
  idFromLocation,
  parseScriptFields,
  scriptFormFields,
  scriptItemPath,
  scriptUpdatePath,
  scriptsFromResponse,
  type CustomScript,
} from './_shared'

/**
 * Deploy Trend Vision One custom scripts over the public REST API. Scripts are
 * upserted BY FILE NAME (the config-as-code identity):
 *   list:   GET  /response/customScripts                     → identity match
 *   create: POST /response/customScripts        (multipart)  → new script, id on Location
 *   update: POST /response/customScripts/{id}/update (multipart)
 *
 * Add/update are one call per script (multipart file upload), so a mid-run failure
 * can leave earlier scripts applied — rollbackData.previous carries every change we
 * made (prior content for scripts we UPDATED, the new id for scripts we CREATED) so
 * rollback can fully undo a partial deploy.
 *
 * VERIFY the multipart field names (`fileType`, `description`, `file`) and the
 * created-id Location header against a live Vision One tenant.
 */

interface ScriptRollbackEntry {
  fileName: string
  /** Prior state when we UPDATED an existing script (restore target); null when we CREATED it. */
  prior: { id: string; fileType: string; description: string; content: string } | null
  /** Id assigned when we CREATED a new script (delete target); null when we updated. */
  createdId: string | null
}

/** Best-effort read of the live custom-script list for identity matching. */
async function listScripts(client: VisionOneClient): Promise<CustomScript[]> {
  try {
    const res = await client.get(CUSTOM_SCRIPT_LIST)
    if (!res.ok) return []
    return scriptsFromResponse(res.json)
  } catch {
    return []
  }
}

/** Best-effort download of a script's current contents (for rollback restore). */
async function downloadContent(client: VisionOneClient, id: string): Promise<string> {
  try {
    const res = await client.get(scriptItemPath(id))
    return res.ok ? res.body : ''
  } catch {
    return ''
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for custom-script deployment' }
  }

  const built = buildVisionOneClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous: ScriptRollbackEntry[] = []
  const applied: string[] = []

  try {
    const live = await listScripts(client)

    for (const item of items) {
      const script = parseScriptFields(item.fields)
      if (!script) continue

      const file = { field: 'file', filename: script.fileName, content: script.content }
      const fields = scriptFormFields(script)
      const match = findScriptByFileName(live, script.fileName)

      if (match && match.id) {
        // Update in place — capture prior contents + metadata first so rollback can restore them.
        const priorContent = await downloadContent(client, match.id)
        const res = await client.postMultipart(scriptUpdatePath(match.id), fields, file)
        const error = visionOneWriteError(res)
        if (error) {
          return {
            success: false,
            message: `Custom-script deploy failed updating ${script.fileName}: ${error}`,
            artifacts: { applied },
            rollbackData: { previous },
          }
        }
        previous.push({
          fileName: script.fileName,
          prior: {
            id: match.id,
            fileType: String(match.fileType ?? script.fileType),
            description: String(match.description ?? ''),
            content: priorContent,
          },
          createdId: null,
        })
      } else {
        // Create — the new id comes back on the Location header.
        const res = await client.postMultipart(CUSTOM_SCRIPT_ADD, fields, file)
        const error = visionOneWriteError(res)
        if (error) {
          return {
            success: false,
            message: `Custom-script deploy failed adding ${script.fileName}: ${error}`,
            artifacts: { applied },
            rollbackData: { previous },
          }
        }
        previous.push({ fileName: script.fileName, prior: null, createdId: idFromLocation(res.headers) })
      }

      applied.push(script.fileName)
    }

    if (applied.length === 0) {
      return { success: true, message: 'No custom scripts to apply.', artifacts: { applied: [] }, rollbackData: { previous: [] } }
    }

    return {
      success: true,
      message: `Applied ${applied.length} custom script(s): ${applied.join(', ')}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Custom-script deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
