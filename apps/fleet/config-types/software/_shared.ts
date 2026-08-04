// Shared helpers for the Fleet software config type (Fleet-maintained apps +
// App Store/VPP apps). Reconciles like queries/labels/policies (find-by-
// identity, then create-or-update) rather than a whole-scope replace, since
// Fleet has no batch endpoint for software titles.
//
// Fleet's own REST API docs are self-inconsistent about the team-scoping body
// key for these specific endpoints: the parameter TABLE names it `fleet_id`
// (Fleet's newer term for what was "team"), but the worked EXAMPLE request
// bodies for "Add Fleet-maintained app", "Add app store app", "Update app
// store app" and "Delete software" all show `team_id` instead. Rather than
// guess which one the server actually reads, every write in this module sends
// BOTH keys — extra JSON/query keys a REST API doesn't recognize are ignored.
// Verify against a live Fleet (fleetdm) instance and drop whichever key that
// instance's docs confirm is unused.
import { getAllPages, getJson, sendJson, sendMultipart, fleetRequest, FLEET_API_BASE } from '../../lib/fleetApi'

export const SOURCE_TYPES = new Set(['fleet_maintained', 'app_store'])
export const PLATFORMS = new Set(['darwin', 'ios', 'ipados', 'android'])

export interface FleetSoftwarePackage {
  fleet_maintained_app_id?: number | null
  self_service?: boolean
  install_script?: string
  post_install_script?: string
  pre_install_query?: string
  categories?: string[] | null
}

export interface FleetAppStoreApp {
  app_store_id?: string | number
  self_service?: boolean
  categories?: string[] | null
  auto_update_enabled?: boolean
  auto_update_window_start?: string
  auto_update_window_end?: string
}

export interface FleetSoftwareTitle {
  id: number
  name: string
  software_package?: FleetSoftwarePackage | null
  app_store_app?: FleetAppStoreApp | null
}

export interface SoftwareItem {
  sourceType: 'fleet_maintained' | 'app_store'
  identifier: string
  platform: string
  teamId: number
  selfService: boolean
  categories: string[]
  installScript: string
  postInstallScript: string
  preInstallQuery: string
  autoUpdateEnabled: boolean
  autoUpdateWindowStart: string
  autoUpdateWindowEnd: string
  labelsIncludeAll: string[]
  labelsIncludeAny: string[]
}

export function parseLabelList(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function normalizeItem(fields: Record<string, unknown>): SoftwareItem {
  const sourceType = String(fields.sourceType ?? 'fleet_maintained').trim() === 'app_store' ? 'app_store' : 'fleet_maintained'
  return {
    sourceType,
    identifier: String(fields.identifier ?? '').trim(),
    platform: String(fields.platform ?? 'darwin').trim().toLowerCase(),
    teamId: Number(String(fields.teamId ?? '0').trim()) || 0,
    selfService: String(fields.selfService ?? 'no').trim().toLowerCase() === 'yes',
    categories: parseLabelList(fields.categories),
    installScript: String(fields.installScript ?? ''),
    postInstallScript: String(fields.postInstallScript ?? ''),
    preInstallQuery: String(fields.preInstallQuery ?? ''),
    autoUpdateEnabled: String(fields.autoUpdateEnabled ?? 'no').trim().toLowerCase() === 'yes',
    autoUpdateWindowStart: String(fields.autoUpdateWindowStart ?? '').trim(),
    autoUpdateWindowEnd: String(fields.autoUpdateWindowEnd ?? '').trim(),
    labelsIncludeAll: parseLabelList(fields.labelsIncludeAll),
    labelsIncludeAny: parseLabelList(fields.labelsIncludeAny),
  }
}

/** List every software title added to a team scope (best-effort). */
export async function listTitlesForTeam(
  base: string,
  headers: Record<string, string>,
  teamId: number,
): Promise<FleetSoftwareTitle[]> {
  try {
    return await getAllPages<FleetSoftwareTitle>(
      `${base}${FLEET_API_BASE}/software/titles?fleet_id=${teamId}&available_for_install=true`,
      headers,
      (page) => (page as { software_titles?: FleetSoftwareTitle[] }).software_titles,
    )
  } catch {
    return []
  }
}

/** Find an existing title by its Fleet-maintained-app id or App Store id (best-effort). */
export async function findTitleByIdentifier(
  base: string,
  headers: Record<string, string>,
  teamId: number,
  sourceType: 'fleet_maintained' | 'app_store',
  identifier: string,
): Promise<FleetSoftwareTitle | null> {
  const titles = await listTitlesForTeam(base, headers, teamId)
  if (sourceType === 'fleet_maintained') {
    const id = Number(identifier)
    return titles.find((t) => t.software_package?.fleet_maintained_app_id === id) ?? null
  }
  return titles.find((t) => String(t.app_store_app?.app_store_id ?? '') === identifier) ?? null
}

export async function createFleetMaintained(
  base: string,
  headers: Record<string, string>,
  item: SoftwareItem,
): Promise<{ software_title_id: number }> {
  return sendJson('POST', `${base}${FLEET_API_BASE}/software/fleet_maintained_apps`, headers, {
    fleet_maintained_app_id: Number(item.identifier),
    team_id: item.teamId,
    fleet_id: item.teamId,
    self_service: item.selfService,
    ...(item.installScript ? { install_script: item.installScript } : {}),
    ...(item.postInstallScript ? { post_install_script: item.postInstallScript } : {}),
    ...(item.preInstallQuery ? { pre_install_query: item.preInstallQuery } : {}),
    ...(item.labelsIncludeAll.length ? { labels_include_all: item.labelsIncludeAll } : {}),
    ...(item.labelsIncludeAny.length ? { labels_include_any: item.labelsIncludeAny } : {}),
  })
}

export async function createAppStoreApp(
  base: string,
  headers: Record<string, string>,
  item: SoftwareItem,
): Promise<{ software_title_id: number }> {
  return sendJson('POST', `${base}${FLEET_API_BASE}/software/app_store_apps`, headers, {
    app_store_id: item.identifier,
    team_id: item.teamId,
    fleet_id: item.teamId,
    platform: item.platform,
    self_service: item.selfService,
    ...(item.categories.length ? { categories: item.categories } : {}),
    ...(item.labelsIncludeAll.length ? { labels_include_all: item.labelsIncludeAll } : {}),
    ...(item.labelsIncludeAny.length ? { labels_include_any: item.labelsIncludeAny } : {}),
  })
}

/** Converge a Fleet-maintained title's overrides via the (multipart, no file needed) package-update endpoint. */
export async function updateFleetMaintainedOverrides(
  base: string,
  headers: Record<string, string>,
  titleId: number,
  item: Pick<SoftwareItem, 'teamId' | 'selfService' | 'categories' | 'installScript' | 'postInstallScript' | 'preInstallQuery'>,
): Promise<void> {
  const fields = [
    { name: 'fleet_id', value: String(item.teamId) },
    { name: 'self_service', value: String(item.selfService) },
  ]
  if (item.categories.length) fields.push({ name: 'categories', value: JSON.stringify(item.categories) })
  if (item.installScript) fields.push({ name: 'install_script', value: item.installScript })
  if (item.postInstallScript) fields.push({ name: 'post_install_script', value: item.postInstallScript })
  if (item.preInstallQuery) fields.push({ name: 'pre_install_query', value: item.preInstallQuery })
  await sendMultipart('PATCH', `${base}${FLEET_API_BASE}/software/titles/${titleId}/package`, headers, fields, [])
}

/** Converge an App Store title's overrides via the JSON app_store_app update endpoint. */
export async function updateAppStoreOverrides(
  base: string,
  headers: Record<string, string>,
  titleId: number,
  item: Pick<SoftwareItem, 'teamId' | 'selfService' | 'categories' | 'autoUpdateEnabled' | 'autoUpdateWindowStart' | 'autoUpdateWindowEnd'>,
): Promise<void> {
  await sendJson('PATCH', `${base}${FLEET_API_BASE}/software/titles/${titleId}/app_store_app`, headers, {
    team_id: item.teamId,
    fleet_id: item.teamId,
    self_service: item.selfService,
    ...(item.categories.length ? { categories: item.categories } : {}),
    auto_update_enabled: item.autoUpdateEnabled,
    ...(item.autoUpdateEnabled
      ? { auto_update_window_start: item.autoUpdateWindowStart, auto_update_window_end: item.autoUpdateWindowEnd }
      : {}),
  })
}

/** Removes a title's availability for install/add from a team (does not uninstall it from hosts). */
export async function deleteSoftwareTitle(
  base: string,
  headers: Record<string, string>,
  titleId: number,
  teamId: number,
): Promise<void> {
  const res = await fleetRequest(
    `${base}${FLEET_API_BASE}/software/titles/${titleId}/available_for_install?team_id=${teamId}&fleet_id=${teamId}`,
    { method: 'DELETE', headers },
  )
  if (!res.ok) {
    throw new Error(`DELETE software/titles/${titleId}/available_for_install → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  }
}

/** Fetch a single title by id (used when re-reading state for drift, best-effort). */
export async function getTitle(
  base: string,
  headers: Record<string, string>,
  titleId: number,
  teamId: number,
): Promise<FleetSoftwareTitle | null> {
  try {
    return await getJson<{ software_title: FleetSoftwareTitle }>(
      `${base}${FLEET_API_BASE}/software/titles/${titleId}?fleet_id=${teamId}`,
      headers,
    ).then((r) => r.software_title)
  } catch {
    return null
  }
}
