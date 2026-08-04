// Shared helpers for the Fleet MDM configuration-profiles config type (deploy +
// driftDetect + rollback). This resource is a WHOLE-LIST REPLACE per team scope
// (POST /api/v1/fleet/configuration_profiles/batch) — the same shape Cisco
// Meraki's L3/L7 firewall rules use — so items are grouped by teamId before
// each scope is submitted as one batch.
import { getAllPages, getJson, fleetRequest, FLEET_API_BASE } from '../../lib/fleetApi'

/** Canvas platform choices — kept in sync with canvas.yaml / validate.ts. */
export const PLATFORMS = new Set(['macos', 'windows'])

/** One canvas item's fields, normalized. */
export interface ProfileItem {
  name: string
  platform: string
  displayName: string
  profileContent: string
  teamId: number | undefined
  labelsIncludeAll: string[]
  labelsIncludeAny: string[]
  labelsExcludeAny: string[]
}

/** Profile metadata as Fleet returns it from GET /api/v1/fleet/configuration_profiles. */
export interface FleetProfileMeta {
  profile_uuid: string
  team_id?: number
  name?: string
  platform?: string
  identifier?: string
}

/** Comma-separated label list → trimmed, non-empty names. */
export function parseLabelList(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Team ID text field ('' or undefined → undefined = "Unassigned"). */
export function toTeamId(value: unknown): number | undefined {
  const raw = String(value ?? '').trim()
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

export function normalizeItem(fields: Record<string, unknown>): ProfileItem {
  return {
    name: String(fields.name ?? '').trim(),
    platform: String(fields.platform ?? 'macos').trim().toLowerCase(),
    displayName: String(fields.displayName ?? '').trim(),
    profileContent: String(fields.profileContent ?? ''),
    teamId: toTeamId(fields.teamId),
    labelsIncludeAll: parseLabelList(fields.labelsIncludeAll),
    labelsIncludeAny: parseLabelList(fields.labelsIncludeAny),
    labelsExcludeAny: parseLabelList(fields.labelsExcludeAny),
  }
}

/** Group canvas items by their (possibly undefined = "Unassigned") team scope. */
export function groupByTeam(items: ProfileItem[]): Map<number | undefined, ProfileItem[]> {
  const groups = new Map<number | undefined, ProfileItem[]>()
  for (const item of items) {
    const list = groups.get(item.teamId) ?? []
    list.push(item)
    groups.set(item.teamId, list)
  }
  return groups
}

/** The batch endpoint's per-profile shape, from ProfileItem + base64 content. */
export function toBatchEntry(item: ProfileItem, contentBase64: string): Record<string, unknown> {
  const entry: Record<string, unknown> = { profile: contentBase64 }
  if (item.displayName) entry.display_name = item.displayName
  if (item.labelsIncludeAll.length) entry.labels_include_all = item.labelsIncludeAll
  else if (item.labelsIncludeAny.length) entry.labels_include_any = item.labelsIncludeAny
  if (item.labelsExcludeAny.length) entry.labels_exclude_any = item.labelsExcludeAny
  return entry
}

/** POST the whole-list replace for one team scope. teamId undefined = "Unassigned". */
export async function batchReplaceProfiles(
  base: string,
  headers: Record<string, string>,
  teamId: number | undefined,
  entries: Array<Record<string, unknown>>,
): Promise<void> {
  const query = teamId === undefined ? '' : `?fleet_id=${teamId}`
  const res = await fleetRequest(`${base}${FLEET_API_BASE}/configuration_profiles/batch${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ configuration_profiles: entries }),
  })
  if (!res.ok) {
    throw new Error(
      `POST configuration_profiles/batch (team ${teamId ?? 'Unassigned'}) → HTTP ${res.status}: ${res.body.slice(0, 300)}`,
    )
  }
}

/** List every existing profile's metadata for a team scope (best-effort). */
export async function listProfilesForTeam(
  base: string,
  headers: Record<string, string>,
  teamId: number | undefined,
): Promise<FleetProfileMeta[]> {
  const query = teamId === undefined ? '' : `?fleet_id=${teamId}`
  try {
    return await getAllPages<FleetProfileMeta>(
      `${base}${FLEET_API_BASE}/configuration_profiles${query}`,
      headers,
      (page) => (page as { profiles?: FleetProfileMeta[] }).profiles,
    )
  } catch {
    return []
  }
}

/** Download one profile's raw content (best-effort — null when it can't be read). */
export async function downloadProfileContentBase64(
  base: string,
  headers: Record<string, string>,
  profileUuid: string,
): Promise<string | null> {
  try {
    const res = await fleetRequest(`${base}${FLEET_API_BASE}/configuration_profiles/${profileUuid}?alt=media`, {
      headers,
    })
    if (!res.ok) return null
    return Buffer.from(res.body, 'utf8').toString('base64')
  } catch {
    return null
  }
}

export interface FleetProfileDetail extends FleetProfileMeta {
  labels_include_all?: Array<{ name: string }>
  labels_include_any?: Array<{ name: string }>
  labels_exclude_any?: Array<{ name: string }>
}

/** Fetch a single profile's full metadata (used to re-derive display_name/labels for rollback). */
export async function getProfileMeta(
  base: string,
  headers: Record<string, string>,
  profileUuid: string,
): Promise<FleetProfileDetail | null> {
  try {
    return await getJson<FleetProfileDetail>(`${base}${FLEET_API_BASE}/configuration_profiles/${profileUuid}`, headers)
  } catch {
    return null
  }
}

/** One captured prior profile, enough to fully reconstruct its batch entry on rollback. */
export interface PriorProfile {
  displayName: string
  contentBase64: string
  labelsIncludeAll: string[]
  labelsIncludeAny: string[]
  labelsExcludeAny: string[]
}

/** Snapshot every existing profile in a team scope (best-effort — a profile that can't be downloaded is skipped). */
export async function snapshotTeamProfiles(
  base: string,
  headers: Record<string, string>,
  teamId: number | undefined,
): Promise<PriorProfile[]> {
  const metas = await listProfilesForTeam(base, headers, teamId)
  const snapshots: PriorProfile[] = []
  for (const meta of metas) {
    const contentBase64 = await downloadProfileContentBase64(base, headers, meta.profile_uuid)
    if (contentBase64 === null) continue // best-effort: skip a profile we can't read back
    const detail = await getProfileMeta(base, headers, meta.profile_uuid)
    snapshots.push({
      displayName: detail?.name ?? meta.name ?? '',
      contentBase64,
      labelsIncludeAll: (detail?.labels_include_all ?? []).map((l) => l.name),
      labelsIncludeAny: (detail?.labels_include_any ?? []).map((l) => l.name),
      labelsExcludeAny: (detail?.labels_exclude_any ?? []).map((l) => l.name),
    })
  }
  return snapshots
}

/** Rebuild a batch entry from a captured PriorProfile (for rollback). */
export function priorToBatchEntry(prior: PriorProfile): Record<string, unknown> {
  const entry: Record<string, unknown> = { profile: prior.contentBase64 }
  if (prior.displayName) entry.display_name = prior.displayName
  if (prior.labelsIncludeAll.length) entry.labels_include_all = prior.labelsIncludeAll
  else if (prior.labelsIncludeAny.length) entry.labels_include_any = prior.labelsIncludeAny
  if (prior.labelsExcludeAny.length) entry.labels_exclude_any = prior.labelsExcludeAny
  return entry
}
