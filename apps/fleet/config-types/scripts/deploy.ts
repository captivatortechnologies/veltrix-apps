import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader, sendMultipart, FLEET_API_BASE } from '../../lib/fleetApi'
import { toTeamId, toFilename, findScriptByFilename, downloadScriptContent } from './_shared'

interface PriorScript {
  filename: string
  teamId: number | undefined
  priorScriptId: number | null
  priorContent: string | null
  createdScriptId?: number
}

/**
 * Deploy Fleet library scripts via the multipart REST API, upserting by
 * uploaded filename (name + extension) within a team scope:
 *   read (rollback): GET    /api/v1/fleet/scripts?fleet_id=<team>  → find by filename (miss = new script)
 *   snapshot:        GET    /api/v1/fleet/scripts/{id}?alt=media   → download prior content, when it exists
 *   create:          POST   /api/v1/fleet/scripts                 multipart: script=<file>, fleet_id=<team>
 *   update:          PATCH  /api/v1/fleet/scripts/{id}             multipart: script=<file>
 *
 * There is no JSON path for this resource — Fleet only accepts a file upload —
 * so this is the one config type in this app that talks multipart/form-data.
 * rollbackData records the prior script per filename (its id + downloaded
 * content, or null when it did not exist, plus the id Fleet assigned on
 * create) so rollback can PATCH the content back or DELETE the one we created.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for script deployment' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: PriorScript[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const teamId = toTeamId(item.fields.teamId)
      const filename = toFilename(name, item.fields.scriptType)
      const content = String(item.fields.scriptContent ?? '')

      const existing = await findScriptByFilename(base, headers, teamId, filename)
      const entry: PriorScript = { filename, teamId, priorScriptId: existing?.id ?? null, priorContent: null }

      if (existing) {
        entry.priorContent = await downloadScriptContent(base, headers, existing.id)
        await sendMultipart(
          'PATCH',
          `${base}${FLEET_API_BASE}/scripts/${existing.id}`,
          headers,
          [],
          [{ name: 'script', filename, content, contentType: 'text/plain' }],
        )
      } else {
        const fields = teamId === undefined ? [] : [{ name: 'fleet_id', value: String(teamId) }]
        const created = await sendMultipart<{ script_id: number }>(
          'POST',
          `${base}${FLEET_API_BASE}/scripts`,
          headers,
          fields,
          [{ name: 'script', filename, content, contentType: 'text/plain' }],
        )
        entry.createdScriptId = created.script_id
      }

      previous.push(entry)
      applied.push(filename)
    }

    return {
      success: true,
      message: `Applied ${applied.length} script(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Script deploy failed after ${applied.length} script(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
