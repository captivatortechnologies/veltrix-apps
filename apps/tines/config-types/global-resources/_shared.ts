// Shared helpers for the Tines Global Resources (Shared Values) config type
// (validate + deploy + rollback + drift + health).
//
// A Tines Global Resource lives at /api/v1/global_resources and is keyed for
// reconciliation by (team_id, name). File-type resources (base64-encoded
// binary `value.contents`) are intentionally NOT modeled — see the README
// Coverage section.
//
// Docs (fetched 2026-08-05): https://www.tines.com/api/resources
//   list:   GET    /api/v1/global_resources?team_id=  -> { global_resources: [...], meta }
//   create: POST   /api/v1/global_resources  <- { name, team_id, value, folder_id?,
//                     read_access?, shared_team_slugs?, description? }
//   update: PUT    /api/v1/global_resources/{id}  <- { name?, value?, folder_id?,
//                     read_access?, shared_team_slugs?, description? }
//   delete: DELETE /api/v1/global_resources/{id}

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const READ_ACCESS_VALUES = ['TEAM', 'GLOBAL', 'SPECIFIC_TEAMS'] as const

/** A Global Resource as returned by the Tines Resources API. */
export interface LiveGlobalResource {
  id?: number | string
  name?: string
  value?: unknown
  team_id?: number | string
  folder_id?: number | string | null
  read_access?: string
  shared_team_slugs?: string[]
  description?: string
}

/** One canvas item, normalized to the fields this config type manages. */
export interface GlobalResourceSpec {
  itemName: string
  name: string
  teamId: string
  folderName: string
  value: string
  description: string
  readAccess: string
  sharedTeamSlugs: string[]
}

export function extractGlobalResourceSpecs(canvas: CanvasSnapshot): GlobalResourceSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    const slugsRaw = fields.shared_team_slugs
    return {
      itemName: item.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      teamId: typeof fields.team_id === 'string' ? fields.team_id.trim() : String(fields.team_id ?? '').trim(),
      folderName: typeof fields.folder_name === 'string' ? fields.folder_name.trim() : '',
      value: typeof fields.value === 'string' ? fields.value : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      readAccess: typeof fields.read_access === 'string' && fields.read_access ? fields.read_access : 'TEAM',
      sharedTeamSlugs: Array.isArray(slugsRaw) ? slugsRaw.map((s) => String(s).trim()).filter(Boolean) : [],
    }
  })
}

/** Build the request body for POST/PUT /global_resources. */
export function buildGlobalResourceBody(
  spec: GlobalResourceSpec,
  folderId: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    team_id: spec.teamId,
    value: spec.value,
    read_access: spec.readAccess,
  }
  if (folderId) body.folder_id = folderId
  if (spec.description) body.description = spec.description
  if (spec.readAccess === 'SPECIFIC_TEAMS' && spec.sharedTeamSlugs.length > 0) {
    body.shared_team_slugs = spec.sharedTeamSlugs
  }
  return body
}

/** Find a live resource by (team, name) — the reconciliation identity. */
export function findGlobalResource(resources: LiveGlobalResource[], teamId: string, name: string): LiveGlobalResource | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return (
    resources.find((r) => String(r.team_id ?? '') === teamId && String(r.name ?? '').trim().toLowerCase() === n) ?? null
  )
}
