// Shared helpers for the Cisco Umbrella Internal Domains config type
// (validate + deploy + rollback + drift).
//
// An internal domain (/deployments/v2/internaldomains) is a domain whose DNS
// queries bypass the Umbrella resolvers and route to the local resolver instead
// (used by Virtual Appliances and Roaming Clients). Internal domains are
// addressed by an opaque `id` (no lookup-by-name), so a declared domain is
// matched to a live one by its DOMAIN value and the id is stored after deploy for
// rename-safety. Shapes follow the Umbrella Deployments API; verify against a
// live Umbrella tenant.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import {
  DEPLOYMENTS_INTERNAL_DOMAINS_PATH,
  type DeployableResource,
  type LiveResource,
} from '../../lib/deployments'

export const MAX_DOMAIN_LENGTH = 255
// A domain label chain: labels of a-z0-9/hyphen, dot-separated, TLD 2+ letters.
// A leading "*." wildcard is accepted (Umbrella supports wildcard internal domains).
const DOMAIN_RE = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i

export function isDomain(value: string): boolean {
  return DOMAIN_RE.test(value.trim())
}

/** One internal domain declared on the canvas (one item). */
export interface InternalDomainSpec {
  itemId?: string
  /** domain — the logical identity. */
  domain: string
  description: string
  includeAllVAs: boolean
  includeAllMobileDevices: boolean
}

/** An internal domain as returned by GET /deployments/v2/internaldomains. */
export interface LiveInternalDomain extends LiveResource {
  id?: number | string
  originId?: number | string
  domain?: string
  description?: string
  includeAllVAs?: boolean
  includeAllMobileDevices?: boolean
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBoolean(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  return v === 'true' || v === 1 || v === '1'
}

export function extractInternalDomainSpecs(canvas: CanvasSnapshot): InternalDomainSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => ({
    itemId: item.id,
    domain: asString(item.fields?.domain) || item.name,
    description: asString(item.fields?.description),
    includeAllVAs: asBoolean(item.fields?.includeAllVAs),
    includeAllMobileDevices: asBoolean(item.fields?.includeAllMobileDevices),
  }))
}

function liveId(live: LiveResource): string | number | undefined {
  const l = live as LiveInternalDomain
  return l.id ?? l.originId
}

/** Descriptor driving the generic deploy/rollback/drift engine for internal domains. */
export const INTERNAL_DOMAIN_RESOURCE: DeployableResource<InternalDomainSpec> = {
  label: 'internal domain',
  labelPlural: 'internal domains',
  collectionPath: DEPLOYMENTS_INTERNAL_DOMAINS_PATH,
  resourcePath: (id) => `${DEPLOYMENTS_INTERNAL_DOMAINS_PATH}/${encodeURIComponent(String(id))}`,
  keyOfSpec: (spec) => spec.domain.toLowerCase(),
  keyOfLive: (live) => asString((live as LiveInternalDomain).domain).toLowerCase(),
  nameOfSpec: (spec) => spec.domain,
  idOfLive: liveId,
  body: (spec) => ({
    domain: spec.domain,
    description: spec.description,
    includeAllVAs: spec.includeAllVAs,
    includeAllMobileDevices: spec.includeAllMobileDevices,
  }),
  bodyFromLive: (live) => {
    const l = live as LiveInternalDomain
    return {
      domain: asString(l.domain),
      description: asString(l.description),
      includeAllVAs: asBoolean(l.includeAllVAs),
      includeAllMobileDevices: asBoolean(l.includeAllMobileDevices),
    }
  },
}
