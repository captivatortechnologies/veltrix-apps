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

export interface ByolInfrastructure {
  id: string
  name: string
  deploymentType?: string
  environmentType?: string
  indexerCount?: number
  searchHeadCount?: number
  status?: string
  hosting_type?: string
  cloudProviderId?: string | null
  region?: string | null
  indexerRegions?: ByolRegion[]
  searchHeadRegions?: ByolRegion[]
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
  /** Placement of the indexer cluster — single-site or multi-site by percent. */
  indexerPlacement?: ClusterPlacement
  /** Placement of the search-head cluster — single-site or multi-site by percent. */
  searchHeadPlacement?: ClusterPlacement
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
}

export interface FormState {
  name: string
  deploymentType: string
  environmentType: string
  /** A cloud provider id, or the SELF_HOSTED sentinel. */
  providerId: string
  region: string
  indexerCount: string
  searchHeadCount: string
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
  /** Placement of the indexer cluster. */
  indexerPlacement: ClusterPlacement
  /** Placement of the search-head cluster. */
  searchHeadPlacement: ClusterPlacement
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
}

// --- Constants --------------------------------------------------------------

/** Sentinel provider value for a customer-managed (non-cloud) deployment. */
export const SELF_HOSTED = 'self-hosted'
export const SELF_HOSTED_LABEL = 'Self-Hosted'

export const DEFAULT_DEPLOYMENT_TYPES = [
  { value: 'single', label: 'Single instance' },
  { value: 'distributed', label: 'Distributed' },
]

/** Network mode options for the "Deployment target" form section. */
export const NETWORK_MODE_OPTIONS = [
  { value: 'shared', label: 'Veltrix-hosted (shared)' },
  { value: 'dedicated', label: 'Dedicated — your cloud (BYOC)' },
  { value: 'existing', label: 'Existing network — your cloud (BYOC)' },
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
 * Map a persisted infrastructure record back into the editable form state, so
 * "Edit topology" renders the accurate current values (placement, consolidation,
 * forwarders, instance size, network target, …). Missing fields fall back to the
 * same defaults a new form uses, so a legacy row (created before these fields
 * existed) opens cleanly. Pure — safe to unit test.
 */
export function editFormState(row: ByolInfrastructure): FormState {
  const providerId = row.cloudProviderId
    ? row.cloudProviderId
    : row.hosting_type === SELF_HOSTED_LABEL
      ? SELF_HOSTED
      : ''
  return {
    name: row.name ?? '',
    deploymentType: row.deploymentType ?? 'single',
    environmentType: row.environmentType ?? '',
    providerId,
    region: row.region ?? '',
    indexerCount: String(row.indexerCount ?? 1),
    searchHeadCount: String(row.searchHeadCount ?? 1),
    networkMode: row.networkMode ?? 'shared',
    dnsMode: row.dnsMode ?? 'managed',
    cloudAccountConnectionId: row.cloudAccountConnectionId ?? '',
    controlPlaneLayout: row.controlPlaneLayout ?? 'dedicated',
    heavyForwarderCount: String(row.heavyForwarderCount ?? 1),
    instanceType: row.instanceType ?? '',
    indexerPlacement: row.indexerPlacement ?? { mode: 'single' },
    searchHeadPlacement: row.searchHeadPlacement ?? { mode: 'single' },
  }
}

export const BLANK_FORM: FormState = {
  name: '',
  deploymentType: 'single',
  environmentType: '',
  providerId: '',
  region: '',
  indexerCount: '1',
  searchHeadCount: '1',
  networkMode: 'shared',
  dnsMode: 'managed',
  cloudAccountConnectionId: '',
  controlPlaneLayout: 'dedicated',
  heavyForwarderCount: '1',
  instanceType: '',
  indexerPlacement: { mode: 'single' },
  searchHeadPlacement: { mode: 'single' },
}

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
