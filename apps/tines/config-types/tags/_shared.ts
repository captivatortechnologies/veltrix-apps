// Shared helpers for the Tines Tags config type
// (validate + deploy + rollback + drift + health).
//
// A Tines tag lives at /api/v1/tags and — since Feb 2025 — belongs to exactly
// one team, so it is keyed for reconciliation by (team_id, name).
//
// Docs (fetched 2026-08-05): https://www.tines.com/api/tags
//   list:   GET    /api/v1/tags?team_id=          -> { tags: [...], meta }
//   create: POST   /api/v1/tags     <- { name, team_id, color } -> { id, name, color, teams }
//   update: PUT    /api/v1/tags/{id} <- { name, color }
//   delete: DELETE /api/v1/tags/{id}?team_id=

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const NAMED_COLORS = ['purple', 'blue', 'gold', 'green', 'magenta', 'red', 'orange', 'mint'] as const

/** A tag as returned by the Tines Tags API. */
export interface LiveTag {
  id?: number | string
  name?: string
  color?: string
  teams?: Array<{ id?: number | string; name?: string }>
}

/** One canvas item, normalized to the fields this config type manages. */
export interface TagSpec {
  itemName: string
  name: string
  teamId: string
  color: string
}

export function extractTagSpecs(canvas: CanvasSnapshot): TagSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    const colorField = typeof fields.color === 'string' ? fields.color.trim() : ''
    const custom = typeof fields.custom_color === 'string' ? fields.custom_color.trim() : ''
    return {
      itemName: item.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      teamId: typeof fields.team_id === 'string' ? fields.team_id.trim() : String(fields.team_id ?? '').trim(),
      color: colorField === 'custom' ? custom : colorField,
    }
  })
}

/** Build the request body for POST /tags. */
export function buildTagCreateBody(spec: TagSpec): { name: string; team_id: string; color: string } {
  return { name: spec.name, team_id: spec.teamId, color: spec.color }
}

/** Build the request body for PUT /tags/{id} (team is not editable after creation). */
export function buildTagUpdateBody(spec: TagSpec): { name: string; color: string } {
  return { name: spec.name, color: spec.color }
}

/** Find a live tag by (team, name) — the reconciliation identity. */
export function findTag(tags: LiveTag[], teamId: string, name: string): LiveTag | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return (
    tags.find(
      (t) =>
        String(t.name ?? '').trim().toLowerCase() === n &&
        (t.teams ?? []).some((team) => String(team.id ?? '') === teamId),
    ) ?? null
  )
}
