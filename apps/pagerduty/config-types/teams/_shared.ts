// Shared helpers for the PagerDuty Teams config type
// (validate + deploy + rollback + drift + health).
//
// A PagerDuty team lives at /teams and is keyed for reconciliation by its `name`
// (PagerDuty assigns the server id). A team is a lightweight grouping of users,
// services and escalation policies; this config type manages its identity —
// name + description.
//
// Request/response shapes follow the PagerDuty REST API v2 (verified against
// PagerDuty's API reference and the official go-pagerduty client, team.go):
//   list:   GET    /teams          -> { teams: [...] }
//   create: POST   /teams          <- { team: {...} }
//   get:    GET    /teams/{id}      -> { team: {...} }
//   update: PUT    /teams/{id}      <- { team: {...} }
//   delete: DELETE /teams/{id}
//
// Docs: https://developer.pagerduty.com/api-reference/1feb2a8dd7204-create-a-team
//       https://github.com/PagerDuty/go-pagerduty/blob/master/team.go

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** A team as returned by GET /teams. */
export interface LiveTeam {
  id?: string
  type?: string
  name?: string
  description?: string
}

/** One canvas item, normalized to the fields this config type manages. */
export interface TeamSpec {
  itemName: string
  name: string
  description: string
}

/** Each canvas item describes one team. */
export function extractTeamSpecs(canvas: CanvasSnapshot): TeamSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
    }
  })
}

/**
 * Build the request body for POST/PUT /teams. Wrapped in a { team: {...} }
 * envelope by callers. `type` is set explicitly so the API resolves the resource
 * unambiguously.
 */
export function buildTeamBody(spec: TeamSpec): LiveTeam {
  const body: LiveTeam = { type: 'team', name: spec.name }
  if (spec.description) body.description = spec.description
  return body
}

/** Rebuild a team body from its prior live shape (used by rollback restore). */
export function teamRestoreBody(prior: LiveTeam): LiveTeam {
  const body: LiveTeam = { type: 'team', name: String(prior.name ?? '') }
  if (prior.description) body.description = prior.description
  return body
}

/** Find a live team by name (case-insensitive — the reconciliation identity). */
export function findTeam(teams: LiveTeam[], name: string): LiveTeam | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return teams.find((t) => String(t.name ?? '').trim().toLowerCase() === n) ?? null
}
