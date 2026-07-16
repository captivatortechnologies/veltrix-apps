// =============================================================================
// Shared types for the BYOL infrastructure manager + detail view.
// =============================================================================

/** A region association satellite row (indexer / search-head placement). */
export interface ByolRegion {
  id: string
  region: string
}

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
}
