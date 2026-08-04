// Shared helpers for the Fleet enroll-secrets config type (deploy + driftDetect
// + rollback). Like config-profiles, this is a WHOLE-LIST REPLACE per scope —
// global (POST /api/v1/fleet/spec/enroll_secret) or per-team
// (PATCH /api/v1/fleet/fleets/{id}/secrets) — so items are grouped by teamId
// before each scope is submitted together.
import { getJson, sendJson, FLEET_API_BASE } from '../../lib/fleetApi'

export interface EnrollSecretItem {
  label: string
  teamId: number | undefined
  value: string
}

/** Team ID text field ('' or undefined → undefined = global scope). */
export function toTeamId(value: unknown): number | undefined {
  const raw = String(value ?? '').trim()
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

export function normalizeItem(fields: Record<string, unknown>): EnrollSecretItem {
  return {
    label: String(fields.label ?? '').trim(),
    teamId: toTeamId(fields.teamId),
    value: String(fields.value ?? ''),
  }
}

/** Group canvas items by their (possibly undefined = global) scope. */
export function groupByScope(items: EnrollSecretItem[]): Map<number | undefined, EnrollSecretItem[]> {
  const groups = new Map<number | undefined, EnrollSecretItem[]>()
  for (const item of items) {
    const list = groups.get(item.teamId) ?? []
    list.push(item)
    groups.set(item.teamId, list)
  }
  return groups
}

/** GET the live secret VALUES for a scope (best-effort — empty array on failure). */
export async function getSecretsForScope(
  base: string,
  headers: Record<string, string>,
  teamId: number | undefined,
): Promise<string[]> {
  try {
    if (teamId === undefined) {
      const res = await getJson<{ spec?: { secrets?: Array<{ secret: string }> } }>(
        `${base}${FLEET_API_BASE}/spec/enroll_secret`,
        headers,
      )
      return (res.spec?.secrets ?? []).map((s) => s.secret)
    }
    const res = await getJson<{ secrets?: Array<{ secret: string }> }>(
      `${base}${FLEET_API_BASE}/fleets/${teamId}/secrets`,
      headers,
    )
    return (res.secrets ?? []).map((s) => s.secret)
  } catch {
    return []
  }
}

/** Whole-list REPLACE the secrets for a scope. */
export async function setSecretsForScope(
  base: string,
  headers: Record<string, string>,
  teamId: number | undefined,
  secrets: string[],
): Promise<void> {
  if (teamId === undefined) {
    await sendJson('POST', `${base}${FLEET_API_BASE}/spec/enroll_secret`, headers, {
      spec: { secrets: secrets.map((secret) => ({ secret })) },
    })
    return
  }
  await sendJson('PATCH', `${base}${FLEET_API_BASE}/fleets/${teamId}/secrets`, headers, {
    secrets: secrets.map((secret) => ({ secret })),
  })
}
