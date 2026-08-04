import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { readIllumioSettings, resolveIllumioCredential, buildIllumioBaseUrl, orgPath, basicAuthHeader, getJson, sendJson, MISSING_CREDENTIAL_MESSAGE } from '../../lib/illumioApi'
import { extractPairingProfileSpecs, type PairingProfileSpec } from './validate'

/** See config-types/labels/deploy.ts — same generous cap, same reasoning. */
const LIST_MAX_RESULTS = 10000

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  /** The pairing profile's href (e.g. "/orgs/1/pairing_profiles/18"). */
  href: string
  prior?: Record<string, unknown>
}

interface LiveLabel {
  href?: string
  key?: string
  value?: string
}
interface LivePairingProfile {
  href?: string
  name?: string
  [key: string]: unknown
}

function labelIdentity(key: string, value: string): string {
  return `${key} ${value}`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Parse "unlimited" | integer-string into a number, or undefined to omit the field (server default = unlimited). */
function toOptionalInt(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  return Number(value)
}

/** Resolve labelsJson refs to hrefs. Throws — FAIL CLOSED — on the first unresolved label. */
function resolveLabelHrefs(labels: Array<{ key: string; value: string }>, labelHrefByIdentity: Map<string, string>): Array<{ href: string }> {
  return labels.map((l) => {
    const href = labelHrefByIdentity.get(labelIdentity(l.key, l.value))
    if (!href) throw new Error(`references label "${l.key}=${l.value}" which does not exist in the PCE`)
    return { href }
  })
}

function buildBody(spec: PairingProfileSpec, labelHrefs: Array<{ href: string }>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    enabled: spec.enabled,
    enforcement_mode: spec.enforcementMode,
    enforcement_mode_lock: spec.enforcementModeLock,
    env_label_lock: spec.envLabelLock,
    loc_label_lock: spec.locLabelLock,
    role_label_lock: spec.roleLabelLock,
    app_label_lock: spec.appLabelLock,
    log_traffic: spec.logTraffic,
    log_traffic_lock: spec.logTrafficLock,
    visibility_level_lock: spec.visibilityLevelLock,
  }
  if (spec.description) body.description = spec.description
  const allowedUses = toOptionalInt(spec.allowedUsesPerKey)
  if (allowedUses !== undefined) body.allowed_uses_per_key = allowedUses
  const keyLifespan = toOptionalInt(spec.keyLifespan)
  if (keyLifespan !== undefined) body.key_lifespan = keyLifespan
  if (labelHrefs.length) body.labels = labelHrefs
  if (spec.visibilityLevel) body.visibility_level = spec.visibilityLevel
  if (spec.externalDataSet) body.external_data_set = spec.externalDataSet
  if (spec.externalDataReference) body.external_data_reference = spec.externalDataReference
  return body
}

function snapshotLive(live: LivePairingProfile): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name }
  for (const k of [
    'description', 'enabled', 'enforcement_mode', 'enforcement_mode_lock', 'allowed_uses_per_key', 'key_lifespan',
    'labels', 'env_label_lock', 'loc_label_lock', 'role_label_lock', 'app_label_lock', 'log_traffic',
    'log_traffic_lock', 'visibility_level', 'visibility_level_lock', 'external_data_set', 'external_data_reference',
  ]) {
    if (live[k] !== undefined) body[k] = live[k]
  }
  return body
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

/**
 * Deploy Illumio pairing profiles — NO draft/provision here, unlike every
 * other config type in this app. /orgs/{org_id}/pairing_profiles has no
 * "draft" path segment and the Terraform provider's
 * resource_illumio_pairing_profile.go never calls StoreHref (the hook it uses
 * everywhere else to track a change for later provisioning) — writes take
 * effect immediately, the same posture as labels. FAILS CLOSED on any
 * unresolved label reference.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readIllumioSettings(ctx.settings)
  const base = buildIllumioBaseUrl(settings)
  if (!base) return { success: false, message: 'No PCE host is configured — set the "PCE host" app setting.' }
  const cred = resolveIllumioCredential(ctx.credential)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const headers = basicAuthHeader(cred)
  const opts = { timeoutMs: settings.timeoutMs, verifyTls: settings.verifyTls }
  const listUrl = `${base}${orgPath(settings, 'pairing_profiles')}`

  const allSpecs = extractPairingProfileSpecs(ctx.canvas)
  const specs = allSpecs.filter((s) => s.name && !s.labelsError)
  const failures: string[] = []
  const entries: RollbackEntry[] = []

  let liveLabels: LiveLabel[]
  let live: LivePairingProfile[]
  try {
    ;[liveLabels, live] = await Promise.all([
      getJson<LiveLabel[]>(`${base}${orgPath(settings, 'labels')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
      getJson<LivePairingProfile[]>(`${listUrl}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
    ])
  } catch (err) {
    return { success: false, message: `Failed to list PCE policy objects: ${errorMessage(err)}` }
  }
  const labelHrefByIdentity = new Map(
    liveLabels.filter((l) => l.key !== undefined && l.value !== undefined && l.href).map((l) => [labelIdentity(l.key!, l.value!), l.href!]),
  )
  const liveByName = new Map(live.filter((l) => l.name).map((l) => [l.name!.toLowerCase(), l]))
  const prior = await loadPriorEntries(ctx)

  for (const spec of specs) {
    let labelHrefs: Array<{ href: string }>
    try {
      labelHrefs = resolveLabelHrefs(spec.labels, labelHrefByIdentity)
    } catch (err) {
      failures.push(`${spec.name}: ${errorMessage(err)}`)
      continue
    }

    const body = buildBody(spec, labelHrefs)
    const liveMatch = liveByName.get(spec.name.toLowerCase()) ?? null
    if (liveMatch?.href) {
      try {
        await sendJson('PUT', `${base}${liveMatch.href}`, headers, body, opts)
      } catch (err) {
        failures.push(`${spec.name}: update failed — ${errorMessage(err)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, href: liveMatch.href, prior: snapshotLive(liveMatch) })
      continue
    }

    try {
      const created = await sendJson<LivePairingProfile>('POST', listUrl, headers, body, opts)
      if (!created?.href) {
        failures.push(`${spec.name}: create succeeded but the PCE returned no href`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, href: created.href })
    } catch (err) {
      failures.push(`${spec.name}: create failed — ${errorMessage(err)}`)
    }
  }

  // Reconcile: delete pairing profiles THIS app created previously but no longer declares.
  const allCurrentNames = new Set(allSpecs.filter((s) => s.name).map((s) => s.name.toLowerCase()))
  for (const p of prior) {
    if (p.existed || !p.href) continue
    if (allCurrentNames.has(p.name.toLowerCase())) continue
    try {
      await sendJson('DELETE', `${base}${p.href}`, headers, undefined, opts)
    } catch (err) {
      failures.push(`delete ${p.name}: ${errorMessage(err)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some pairing profiles failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} pairing profile(s)`, rollbackData: { entries } }
}
