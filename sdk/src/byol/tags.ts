// =============================================================================
// BYOL tenant / cost-allocation tag builder (pure, React-free).
//
// Every Veltrix-provisioned object (the allocated subnet + every environment
// resource) is stamped with a CANONICAL tag set so cloud spend can be attributed
// per customer / per app and tenants stay isolated within the shared Network.
// These keys are the platform-wide contract — billing reconciliation and the
// least-privilege IAM policy (`Veltrix:ManagedBy=Veltrix`) rely on them, so an
// app may ADD its own tags but must never rename or drop these.
//
// Derived entirely from context the app already holds (customerId, the infra
// record, appId) — no I/O, no cloud round-trip — so it runs identically on the
// Plan preview (`GET /byol/:id/plan`) and the Apply commit
// (`POST /byol/:id/deploy`), keeping the previewed tags and the applied tags
// equal by construction. Kept React-free so any BYOL app can reuse it server-side.
//
// NOTE: like the topology + plan diff, the app server keeps its OWN copy
// (apps/<id>/lib/byolTags.ts) rather than importing this at runtime — an app must
// not depend on a byol/root SDK export that may be absent in the pinned
// @veltrixsecops/app-sdk version. Keep the two in sync.
// =============================================================================

/** Context a BYOL tag set is derived from — everything the app already holds. */
export interface ByolTagInput {
  /** Tenant id — cost attribution + tenant isolation. */
  customerId: string
  /** Unique environment id (the infrastructure record id). */
  infrastructureId: string
  /** Human environment name. */
  name: string
  /** Environment class, e.g. prod / staging / dev. */
  environmentType: string
  /** Owning app, e.g. `splunk-enterprise`. */
  appId: string
  /** Billing account / cost center; falls back to `customerId`. */
  costCenter?: string | null
  /** Initiating user / owner; falls back to `customerId`. */
  owner?: string | null
}

/** An ordered tag map. Insertion order IS the canonical display order. */
export type ByolTags = Record<string, string>

/**
 * The canonical tag keys, in the order they are emitted. Exported so callers +
 * tests can assert against the contract without re-deriving it.
 */
export const BYOL_TAG_KEYS = [
  'Veltrix:Customer',
  'Veltrix:Environment',
  'Veltrix:EnvName',
  'Veltrix:EnvType',
  'Veltrix:App',
  'Veltrix:ManagedBy',
  'CostCenter',
  'Owner',
] as const

/** The constant value stamped on `Veltrix:ManagedBy` (drives tag-scoped IAM). */
export const MANAGED_BY = 'Veltrix'

/** Coerce a tag value to a trimmed string (tags are always strings). */
function s(value: string | null | undefined): string {
  return String(value ?? '').trim()
}

/**
 * Build the canonical cost-allocation / tenant-isolation tag set for a BYOL
 * environment. Pure: the same input always yields the same ordered map.
 *
 *   Veltrix:Customer    = customerId
 *   Veltrix:Environment = infrastructureId      (unique env id)
 *   Veltrix:EnvName     = name
 *   Veltrix:EnvType     = environmentType       (prod / staging / …)
 *   Veltrix:App         = appId                 (splunk-enterprise, …)
 *   Veltrix:ManagedBy   = Veltrix               (constant; tag-scoped IAM)
 *   CostCenter          = costCenter ?? customerId
 *   Owner               = owner ?? customerId
 */
export function buildByolTags(input: ByolTagInput): ByolTags {
  const customerId = s(input.customerId)
  const costCenter = s(input.costCenter) || customerId
  const owner = s(input.owner) || customerId

  // Object literal in canonical key order — string keys preserve insertion order.
  return {
    'Veltrix:Customer': customerId,
    'Veltrix:Environment': s(input.infrastructureId),
    'Veltrix:EnvName': s(input.name),
    'Veltrix:EnvType': s(input.environmentType),
    'Veltrix:App': s(input.appId),
    'Veltrix:ManagedBy': MANAGED_BY,
    CostCenter: costCenter,
    Owner: owner,
  }
}
