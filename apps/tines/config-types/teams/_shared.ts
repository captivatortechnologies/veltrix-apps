// Shared helpers for the Tines Teams config type
// (validate + deploy + rollback + drift + health).
//
// A Tines team lives at /api/v1/teams and is keyed for reconciliation by its
// `name` (Tines assigns the server id).
//
// Docs (fetched 2026-08-05): https://www.tines.com/api/teams
//   list:   GET    /api/v1/teams        -> { teams: [...], meta }
//   create: POST   /api/v1/teams        <- { name }         -> { id, name }
//   get:    GET    /api/v1/teams/{id}    -> { id, name, groups }
//   update: PUT    /api/v1/teams/{id}    <- { name }         -> { id, name }
//   delete: DELETE /api/v1/teams/{id}

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** A team as returned by the Tines Teams API. */
export interface LiveTeam {
  id?: number | string
  name?: string
}

/** One canvas item, normalized to the fields this config type manages. */
export interface TeamSpec {
  itemName: string
  name: string
}

export function extractTeamSpecs(canvas: CanvasSnapshot): TeamSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
    }
  })
}

/** Build the request body for POST/PUT /teams. */
export function buildTeamBody(spec: TeamSpec): { name: string } {
  return { name: spec.name }
}

/** Find a live team by name (case-insensitive — the reconciliation identity). */
export function findTeam(teams: LiveTeam[], name: string): LiveTeam | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return teams.find((t) => String(t.name ?? '').trim().toLowerCase() === n) ?? null
}
