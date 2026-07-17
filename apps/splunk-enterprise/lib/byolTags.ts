// =============================================================================
// BYOL tenant / cost-allocation tag builder (app-owned, pure, dependency-free).
//
// Every Veltrix-provisioned object (the allocated subnet + every environment
// resource) is stamped with a CANONICAL tag set so cloud spend can be attributed
// per customer / per app and tenants stay isolated within the shared Network.
// These keys are the platform-wide contract — billing reconciliation and the
// least-privilege IAM policy (`Veltrix:ManagedBy=Veltrix`) rely on them, so the
// app may ADD its own tags but must never rename or drop these.
//
// Derived entirely from context the app already holds — no I/O — so the Plan
// preview (`GET /byol/:id/plan`) and the Apply commit (`POST /byol/:id/deploy`)
// derive an IDENTICAL tag set by construction.
//
// WHY THIS LIVES IN THE APP (not imported from the SDK): identical reasoning to
// byolTopology.ts / byolPlanDiff.ts — the app must not depend on a byol/root SDK
// export that may be absent in whatever @veltrixsecops/app-sdk version the
// platform packages the app against (the app pins ^2.5.0). The SDK keeps its own
// copy (`sdk/src/byol/tags.ts`) for the Plan modal. Keep the two in sync.
// =============================================================================

/** Context a BYOL tag set is derived from — everything the app already holds. */
export interface ByolTagInput {
  customerId: string
  /** Human-readable, unique tenant shortname; falls back to `customerId`. */
  customerShortName?: string | null
  infrastructureId: string
  name: string
  environmentType: string
  appId: string
  costCenter?: string | null
  owner?: string | null
}

/** An ordered tag map. Insertion order IS the canonical display order. */
export type ByolTags = Record<string, string>

/** The canonical tag keys, in the order they are emitted. */
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
 */
export function buildByolTags(input: ByolTagInput): ByolTags {
  const customerId = s(input.customerId)
  // Prefer the human-readable shortname; fall back to the UUID when unset.
  const customerLabel = s(input.customerShortName) || customerId
  const costCenter = s(input.costCenter) || customerLabel
  const owner = s(input.owner) || customerLabel

  return {
    'Veltrix:Customer': customerLabel,
    'Veltrix:Environment': s(input.infrastructureId),
    'Veltrix:EnvName': s(input.name),
    'Veltrix:EnvType': s(input.environmentType),
    'Veltrix:App': s(input.appId),
    'Veltrix:ManagedBy': MANAGED_BY,
    CostCenter: costCenter,
    Owner: owner,
  }
}
