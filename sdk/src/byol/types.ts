// =============================================================================
// Shared types for the BYOL infrastructure manager + detail view.
// =============================================================================

/** A region association satellite row (indexer / search-head placement). */
export interface ByolRegion {
  id: string
  region: string
}

/**
 * Control-plane consolidation layout. Trades HA/isolation for cost by combining
 * management roles onto fewer instances:
 *  - `dedicated`   — 5 instances, one role each (LM, CM, SH-deployer, DS, MC).
 *  - `consolidated`— ~3 instances; CM and SH-deployer stay isolated, the rest combine.
 *  - `single`      — 1 manager node running every management role (small / non-HA).
 * Applies to distributed deployments; single-instance deployments ignore it.
 */
export type ControlPlaneLayout = 'dedicated' | 'consolidated' | 'single'

/** How a cluster's sites are addressed: availability zones (same region) or regions. */
export type PlacementGranularity = 'az' | 'region'

/** One placement target with its share of the cluster's nodes. */
export interface PlacementSite {
  /** AZ id (e.g. `us-east-1a`) when granularity is `az`, or a region code (e.g. `us-west-2`) when `region`. */
  site: string
  /** Percent of the cluster's nodes placed on this site. Percents across a cluster's sites sum to 100. */
  percent: number
}

/**
 * Placement of a single cluster tier. `single` keeps every node in the standard
 * main region/zone; `multi-site` spreads nodes across `sites` by percent.
 * ONLY the indexer and search-head tiers accept multi-site placement — every
 * other tier is always single-site in the main region.
 */
export interface ClusterPlacement {
  mode: 'single' | 'multi-site'
  granularity?: PlacementGranularity
  sites?: PlacementSite[]
}

/** Default single-site placement (all nodes in the main region). */
export const SINGLE_SITE_PLACEMENT: ClusterPlacement = { mode: 'single' }

/** Minimum heavy forwarders in a distributed ingest tier. */
export const MIN_HEAVY_FORWARDERS = 1

/**
 * One node tier in an app's BYOL topology — e.g. Splunk's "Indexers"/"Search
 * heads", or Fleet's single "Fleet servers" tier. Apps declare 1..N of these
 * via `ByolInfrastructureManagerProps.topology`; the manager renders one count
 * input (and, when eligible, one placement editor) per tier instead of the
 * hardcoded Splunk pair.
 */
export interface ByolNodeTier {
  /** Stable id stored per-infra (in `ByolInfrastructure.tiers[].key`). Never rename in place. */
  key: string
  /** Form field / detail label, e.g. "Fleet servers". */
  label: string
  /** Table column header; defaults to `label` when omitted. */
  shortLabel?: string
  /** Distributed-deployment minimum node count. Defaults to 1. */
  min?: number
  /** Default count seeded into a brand-new form. Defaults to 1. */
  default?: number
  /** Helper text shown under the tier's count input. */
  help?: string
  /** Whether this tier supports multi-site placement in a distributed deployment. Defaults to true. */
  placeable?: boolean
}

/**
 * An app's full BYOL node topology — the generic replacement for the SDK's
 * former Splunk-only indexer/search-head pair. Every app supplies its own via
 * `ByolInfrastructureManagerProps.topology`; omitting it defaults to
 * {@link DEFAULT_SPLUNK_TOPOLOGY} for back-compat with existing Splunk rows.
 */
export interface ByolTopology {
  /** Replaces "Splunk" in generated copy (e.g. "BYOL {productName} environment"). */
  productName?: string
  /** 1..N node tiers, in display order. */
  tiers: ByolNodeTier[]
  /** Label for the software-version picker, e.g. "Wazuh version". Omit to use the generic "Version". */
  versionLabel?: string
  /** Overrides the create/edit dialog's subtitle. */
  description?: string
  /** Tooltip text for the ⓘ affordance next to the manager card's title. Omit to hide the icon. */
  infoTooltip?: string
}

/** A single tier's persisted count + (optional) placement, stored on `ByolInfrastructure.tiers`. */
export interface ByolTierValue {
  key: string
  count: number
  placement?: ClusterPlacement | null
  regions?: ByolRegion[]
}

/** The SDK's original Splunk topology — the default when an app supplies no `topology` prop. */
export const DEFAULT_SPLUNK_TOPOLOGY: ByolTopology = {
  productName: 'Splunk',
  versionLabel: 'Splunk version',
  tiers: [
    { key: 'indexer', label: 'Indexers', min: 3 },
    { key: 'searchHead', label: 'Search heads', min: 2 },
  ],
}

export interface ByolInfrastructure {
  id: string
  name: string
  deploymentType?: string
  environmentType?: string
  /** @deprecated Use `tiers` (first tier's count). Kept for back-compat with rows persisted before per-tier storage. */
  indexerCount?: number
  /** @deprecated Use `tiers` (second tier's count). Kept for back-compat with rows persisted before per-tier storage. */
  searchHeadCount?: number
  status?: string
  hosting_type?: string
  cloudProviderId?: string | null
  region?: string | null
  /** @deprecated Use `tiers[].regions`. */
  indexerRegions?: ByolRegion[]
  /** @deprecated Use `tiers[].regions`. */
  searchHeadRegions?: ByolRegion[]
  /** Generic per-tier node counts + placement — the app-agnostic replacement for `indexerCount`/`searchHeadCount`. */
  tiers?: ByolTierValue[]
  /** Deployment target: platform-hosted network, or a customer-owned VPC. Defaults to 'shared'. */
  networkMode?: 'shared' | 'dedicated' | 'existing' | string
  /** DNS strategy for the deployment. Defaults to 'managed'. */
  dnsMode?: 'managed' | 'delegated' | 'private-only' | string
  /** Platform cloud account connection backing a BYOC (dedicated/existing) deployment. */
  cloudAccountConnectionId?: string | null
  /** Control-plane consolidation layout (distributed only). Defaults to 'dedicated'. */
  controlPlaneLayout?: ControlPlaneLayout
  /** Heavy forwarder count in the ingest tier (distributed only). Defaults to 1. */
  heavyForwarderCount?: number
  /** Compute size override for every node (e.g. AWS `t2.medium`); empty = cloud default. */
  instanceType?: string | null
  /** @deprecated Use `tiers[0].placement`. Placement of the first (indexer) cluster. */
  indexerPlacement?: ClusterPlacement
  /** @deprecated Use `tiers[1].placement`. Placement of the second (search-head) cluster. */
  searchHeadPlacement?: ClusterPlacement
  /** Selected software version (app catalog entry id) to install on every node. */
  versionId?: string
  updatedAt?: string
  createdAt?: string
}

/** A persisted resource row (from GET /byol/:id/resources). */
export interface ByolResource {
  id: string
  infrastructureId: string
  tier: string
  kind: string
  name: string
  role: string | null
  region: string | null
  /** Availability zone within `region` for a multi-AZ-placed node; null otherwise. */
  zone?: string | null
  /** Management roles a consolidated control-plane instance runs; null otherwise. */
  roles?: string[] | null
  status: string
  externalRef: string | null
  message: string | null
  planKey: string
  sortOrder: number
}

/** A deployment step (from GET /byol/:id/deployments → steps). */
export interface ByolDeploymentStep {
  id: string
  deploymentId: string
  stepOrder: number
  key: string
  title: string
  status: string
  detail: string | null
  logs: string | null
  startedAt: string | null
  completedAt: string | null
}

/** A deployment run (from GET /byol/:id/deployments). */
export interface ByolDeployment {
  id: string
  infrastructureId: string
  action: string
  status: string
  message: string | null
  startedAt: string
  completedAt: string | null
  steps: ByolDeploymentStep[]
}

/** Platform tag — the customer's environment tags feed the Environment picker. */
export interface Tag {
  id: string
  name: string
}

/** Platform cloud provider — feeds the "Provider" picker (plus Self-Hosted). */
export interface CloudProvider {
  id: string
  name: string
  code?: string
  isActive?: boolean
}

export interface CloudRegion {
  id: string
  name: string
  code: string
  isActive?: boolean
}

/**
 * Platform cloud account connection — feeds the "Cloud account" picker shown
 * for BYOC (dedicated/existing network) deployment targets. Sourced from
 * `GET /api/cloud-accounts`. Only `VERIFIED` accounts matching the selected
 * cloud provider are offered.
 */
export interface CloudAccount {
  id: string
  provider: 'aws' | 'azure' | 'gcp' | 'hetzner' | string
  name: string
  status: 'UNVERIFIED' | 'VERIFIED' | 'ERROR' | string
  authMethod?: string
  /**
   * 'customer' — the tenant's own account (BYOC / dedicated / existing).
   * 'platform' — a Veltrix-managed account a hosted (shared) deployment provisions
   * through. The form offers platform accounts for hosted, customer accounts for BYOC.
   */
  scope?: 'customer' | 'platform' | string
}

export interface FormState {
  name: string
  deploymentType: string
  environmentType: string
  /** A cloud provider id, or the SELF_HOSTED sentinel. */
  providerId: string
  region: string
  /** Node count per tier (form string), keyed by `ByolNodeTier.key`. */
  tierCounts: Record<string, string>
  /** Placement per tier, keyed by `ByolNodeTier.key`. */
  tierPlacement: Record<string, ClusterPlacement>
  /** Deployment target: 'shared' (Veltrix-hosted), 'dedicated', or 'existing' (BYOC). */
  networkMode: string
  /** DNS strategy: 'managed', 'delegated', or 'private-only'. */
  dnsMode: string
  /** Platform cloud account connection id, required when networkMode is BYOC. */
  cloudAccountConnectionId: string
  /** Control-plane consolidation layout (distributed only). */
  controlPlaneLayout: ControlPlaneLayout
  /** Heavy forwarder count as a form string (distributed only, min 1). */
  heavyForwarderCount: string
  /** Compute size override for every node; empty = cloud default (t2.medium-class). */
  instanceType: string
  /** Selected software version (app catalog entry id); empty = app-default. */
  versionId: string
}

/**
 * A link surfaced in the detail view's Configuration section. The app supplies
 * these (the SDK stays app-agnostic). When `configTypeId` + `configBase` are
 * present the link resolves to `<configBase>/<configTypeId>`; otherwise `href`
 * is used verbatim.
 */
export interface ByolConfigLink {
  key: string
  title: string
  description: string
  configTypeId?: string
  href?: string
}

export interface ByolInfrastructureManagerProps {
  /** Base URL of the app's BYOL routes, e.g. `/api/apps/splunk-enterprise/byol`. */
  apiBase: string
  /** Card title. Defaults to "BYOL Infrastructure". */
  title?: string
  /** Deployment topology options. Defaults to Single instance + Distributed. */
  deploymentTypes?: Array<{ value: string; label: string }>
  /**
   * Optional base path to this app's configuration canvases, e.g.
   * `/apps/splunk-enterprise/config`. Combined with each link's `configTypeId`
   * to deep-link the detail view's Configuration section.
   */
  configBase?: string
  /** Configuration links to surface in the detail view (app-supplied). */
  configLinks?: ByolConfigLink[]
  /**
   * Software version options for the "Splunk version" form picker (app-supplied —
   * the SDK has no notion of Splunk). Omit or pass an empty array to hide the
   * picker entirely (e.g. an app with no version catalog).
   */
  versionOptions?: Array<{ value: string; label: string }>
  /**
   * Version id a NEW infrastructure's form should default to (typically the
   * catalog's "latest" entry). Ignored when `versionOptions` is empty. Existing
   * rows always reflect their own stored `versionId`, never this default.
   */
  defaultVersionId?: string
  /**
   * The app's node topology — 1..N tiers (e.g. Fleet's single "Fleet servers"
   * tier, or Splunk's Indexers/Search heads pair). Drives the create/edit
   * form's count + placement fields, the list table's per-tier columns, and
   * the detail view's stats. Defaults to {@link DEFAULT_SPLUNK_TOPOLOGY} when
   * omitted, so existing Splunk-shaped integrations keep working unchanged.
   */
  topology?: ByolTopology
}

// --- Constants --------------------------------------------------------------

/** Sentinel provider value for a customer-managed (non-cloud) deployment. */
export const SELF_HOSTED = 'self-hosted'
export const SELF_HOSTED_LABEL = 'Self-Hosted'

export const DEFAULT_DEPLOYMENT_TYPES = [
  { value: 'single', label: 'Single instance' },
  { value: 'distributed', label: 'Distributed' },
]

/**
 * Network mode options for the "Deployment target" form section. Dedicated is listed
 * first because it is the default: OpenTofu provisions a self-contained VPC. 'shared'
 * requires a platform-managed base network to attach to (not yet provisioned), so it
 * is offered but not the default.
 */
export const NETWORK_MODE_OPTIONS = [
  { value: 'dedicated', label: 'Dedicated — your cloud (BYOC)' },
  { value: 'existing', label: 'Existing network — your cloud (BYOC)' },
  { value: 'shared', label: 'Veltrix-hosted (shared)' },
]

/** DNS mode options for the "Deployment target" form section. */
export const DNS_MODE_OPTIONS = [
  { value: 'managed', label: 'Managed' },
  { value: 'delegated', label: 'Delegated' },
  { value: 'private-only', label: 'Private only' },
]

/** Network modes that require a customer-owned (BYOC) cloud account connection. */
export const BYOC_NETWORK_MODES = new Set(['dedicated', 'existing'])

/** Control-plane consolidation options for the "Control plane" form section. */
export const CONTROL_PLANE_LAYOUT_OPTIONS: Array<{
  value: ControlPlaneLayout
  label: string
  description: string
}> = [
  { value: 'dedicated', label: 'Dedicated', description: '5 servers — one management role each (highest isolation).' },
  { value: 'consolidated', label: 'Consolidated', description: '~3 servers — cluster manager and SH deployer isolated, rest combined.' },
  { value: 'single', label: 'Single node', description: '1 server running every management role (lowest cost, non-HA).' },
]

/** Placement granularity options for a cluster's "Placement" form section. */
export const PLACEMENT_GRANULARITY_OPTIONS: Array<{ value: PlacementGranularity; label: string }> = [
  { value: 'az', label: 'Availability zones (same region)' },
  { value: 'region', label: 'Regions (multi-region)' },
]

/**
 * A tier's persisted count, falling back — for a row with no `tiers` array —
 * to the legacy Splunk fields: the FIRST declared tier reads `indexerCount`,
 * the SECOND reads `searchHeadCount`. Every other tier position has no legacy
 * source. Shared by `editFormState` and the manager's table/sort so a
 * pre-generic-topology row (Splunk-shaped, no `tiers`) keeps rendering
 * correctly under any topology whose first two tiers stand in for indexer/SH.
 */
export function tierValue(row: ByolInfrastructure, tier: ByolNodeTier, index: number): number | undefined {
  const persisted = row.tiers?.find((t) => t.key === tier.key)
  if (persisted) return persisted.count
  if (!row.tiers) {
    if (index === 0) return row.indexerCount
    if (index === 1) return row.searchHeadCount
  }
  return undefined
}

/** Same fallback as {@link tierValue}, for a tier's persisted placement. */
function tierPlacementValue(row: ByolInfrastructure, tier: ByolNodeTier, index: number): ClusterPlacement | undefined {
  const persisted = row.tiers?.find((t) => t.key === tier.key)
  if (persisted) return persisted.placement ?? undefined
  if (!row.tiers) {
    if (index === 0) return row.indexerPlacement
    if (index === 1) return row.searchHeadPlacement
  }
  return undefined
}

/**
 * Map a persisted infrastructure record back into the editable form state, so
 * "Edit topology" renders the accurate current values (placement, consolidation,
 * forwarders, instance size, network target, …). Missing fields fall back to the
 * same defaults a new form uses, so a legacy row (created before these fields
 * existed) opens cleanly. Pure — safe to unit test.
 */
export function editFormState(row: ByolInfrastructure, topology: ByolTopology = DEFAULT_SPLUNK_TOPOLOGY): FormState {
  const providerId = row.cloudProviderId
    ? row.cloudProviderId
    : row.hosting_type === SELF_HOSTED_LABEL
      ? SELF_HOSTED
      : ''
  const tierCounts: Record<string, string> = {}
  const tierPlacement: Record<string, ClusterPlacement> = {}
  topology.tiers.forEach((tier, index) => {
    tierCounts[tier.key] = String(tierValue(row, tier, index) ?? tier.default ?? 1)
    tierPlacement[tier.key] = tierPlacementValue(row, tier, index) ?? { mode: 'single' }
  })
  return {
    name: row.name ?? '',
    deploymentType: row.deploymentType ?? 'single',
    environmentType: row.environmentType ?? '',
    providerId,
    region: row.region ?? '',
    tierCounts,
    tierPlacement,
    networkMode: row.networkMode ?? 'shared',
    dnsMode: row.dnsMode ?? 'managed',
    cloudAccountConnectionId: row.cloudAccountConnectionId ?? '',
    controlPlaneLayout: row.controlPlaneLayout ?? 'dedicated',
    heavyForwarderCount: String(row.heavyForwarderCount ?? 1),
    instanceType: row.instanceType ?? '',
    versionId: row.versionId ?? '',
  }
}

/** Build a brand-new form's initial state for a given topology (its tiers seed `tierCounts`/`tierPlacement`). */
export function blankForm(topology: ByolTopology): FormState {
  const tierCounts: Record<string, string> = {}
  const tierPlacement: Record<string, ClusterPlacement> = {}
  for (const tier of topology.tiers) {
    tierCounts[tier.key] = String(tier.default ?? 1)
    tierPlacement[tier.key] = { mode: 'single' }
  }
  return {
    name: '',
    deploymentType: 'single',
    environmentType: '',
    providerId: '',
    region: '',
    tierCounts,
    tierPlacement,
    // New cloud infra defaults to 'dedicated' — OpenTofu creates its own VPC and the
    // deployment depends on nothing pre-existing. 'shared' attaches to a Veltrix-managed
    // base network that must be provisioned by a separate platform tofu stack; until that
    // stack exists, defaulting to 'shared' produces "no matching VPC" at apply time.
    networkMode: 'dedicated',
    dnsMode: 'managed',
    cloudAccountConnectionId: '',
    controlPlaneLayout: 'dedicated',
    heavyForwarderCount: '1',
    instanceType: '',
    versionId: '',
  }
}

/** Blank form for the default Splunk topology — kept for callers that predate per-app topology. */
export const BLANK_FORM: FormState = blankForm(DEFAULT_SPLUNK_TOPOLOGY)

/**
 * Example compute sizes per cloud (~2 vCPU / 4 GB), shown as form guidance. An
 * empty instanceType uses the module default, which is the first of each here.
 */
export const INSTANCE_TYPE_EXAMPLES: Record<string, string> = {
  aws: 't2.medium',
  azure: 'Standard_B2s',
  gcp: 'e2-medium',
  hetzner: 'cx22',
}
