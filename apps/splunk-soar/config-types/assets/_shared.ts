// Shared helpers for the Assets config type (deploy + rollback + drift).
//
// REST shape follows /rest/asset (docs.splunk.com SOAR PlatformAPI — Asset
// endpoints): name, product_vendor, product_name, description, type, tags,
// primary_owners, primary_voting, secondary_users, secondary_voting, tenants,
// configuration (a per-installed-app object, commonly including
// configuration.ingest for scheduled polling). GET/POST/POST-<id>/DELETE-<id>
// confirmed (POST-<id> is a FULL REPLACE — "any value you do not submit in
// your POST is reset to its default value", per the endpoint's own caution
// note); verify against a live SOAR instance.
//
// `configuration` is WRITE-ONLY here: its shape is defined per installed app
// and commonly mixes ordinary settings with credential fields (API keys,
// passwords) this app cannot tell apart generically. It is sent on every
// deploy but never read back, diffed, or restored on rollback — see deploy.ts/
// rollback.ts/driftDetect.ts. `action_whitelist` and `automation_broker_id` are
// intentionally not modeled — see README Coverage.

import { readStringList, readNumber } from '../../lib/soarCommon'

export interface AssetSpec {
  /** '' when the item has no identity yet. */
  id: string
  /** Every field EXCEPT `configuration` — diffable, comparable, safely restorable on rollback. */
  nonSecretBody: Record<string, unknown> | null
  /** WRITE-ONLY — sent on deploy, never diffed, never restored. */
  configuration: Record<string, unknown>
  error: string | null
}

export interface SoarAsset {
  id?: number | string
  [key: string]: unknown
}

/** Find a live asset by name (case-insensitive — the stable identity). */
export function findAssetByName(assets: SoarAsset[], name: string): SoarAsset | null {
  const target = name.trim().toLowerCase()
  if (!target) return null
  return assets.find((a) => String(a.name ?? '').trim().toLowerCase() === target) ?? null
}

export function buildAssetSpec(fields: Record<string, unknown>): AssetSpec {
  const name = String(fields.name ?? '').trim()
  if (!name) return { id: '', nonSecretBody: null, configuration: {}, error: null }

  const productVendor = String(fields.product_vendor ?? '').trim()
  const productName = String(fields.product_name ?? '').trim()
  if (!productVendor || !productName) {
    return { id: name, nonSecretBody: null, configuration: {}, error: 'Product Vendor and Product Name are both required.' }
  }

  const nonSecretBody: Record<string, unknown> = {
    name,
    product_vendor: productVendor,
    product_name: productName,
    type: String(fields.type ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    tags: readStringList(fields.tags),
    tenants: readStringList(fields.tenants).map((v) => readNumber(v, 0)),
    primary_owners: readStringList(fields.primary_owners).map((v) => readNumber(v, 0)),
    primary_voting: readNumber(fields.primary_voting, 0),
    secondary_users: readStringList(fields.secondary_users).map((v) => readNumber(v, 0)),
    secondary_voting: readNumber(fields.secondary_voting, 0),
  }

  const configuration: Record<string, unknown> = { ...(parseKeyValue(fields.configuration)) }
  const pollEnabled = fields.poll_enabled === true || fields.poll_enabled === 'true'
  const pollLabel = String(fields.poll_container_label ?? '').trim()
  const pollInterval = fields.poll_interval_mins
  if (pollEnabled || pollLabel || (pollInterval !== undefined && pollInterval !== '')) {
    configuration.ingest = {
      poll: pollEnabled,
      ...(pollLabel ? { container_label: pollLabel } : {}),
      ...(pollInterval !== undefined && pollInterval !== '' ? { interval_mins: readNumber(pollInterval, 0) } : {}),
    }
  }

  return { id: name, nonSecretBody, configuration, error: null }
}

/** Read the canvas `keyvalue` field (a plain object) into a flat object, trimming blank keys. */
function parseKeyValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const k = key.trim()
    if (k) out[k] = v
  }
  return out
}
