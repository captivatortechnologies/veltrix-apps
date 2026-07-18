// =============================================================================
// @veltrixsecops/app-sdk/byol — reusable BYOL infrastructure surface.
//
// A searchable/filterable list whose rows open a full deployment console (the
// detail view): summary header, an expandable secondary sidebar, the end-to-end
// resource plan grouped by tier, and a live deployment activity timeline. Any app
// can mount <ByolInfrastructureManager apiBase=… /> pointed at its own app-owned
// `/byol` routes; the app owns the data, this module owns the UI.
// =============================================================================

export { ByolInfrastructureManager, default } from './ByolInfrastructureManager'
export { ByolInfrastructureDetail } from './ByolInfrastructureDetail'
export { ByolPlanModal } from './detail/ByolPlanModal'
export type { ByolPlanModalProps } from './detail/ByolPlanModal'
export { DestroyPlanModal } from './detail/DestroyPlanModal'
export type { DestroyPlanModalProps } from './detail/DestroyPlanModal'

// Plan → Apply diff (pure, React-free — also usable on the server side)
export { diffPlan, buildByolPlan, planHasChanges } from './diffPlan'
export type {
  PlanAction,
  PlanDiff,
  PlanDiffCurrent,
  PlanDiffDesired,
  ByolPlan,
  ByolPlanSummary,
  ByolPlanItem,
  ByolPlanGroup,
  ByolPlanNetwork,
} from './diffPlan'

// Tenant / cost-allocation tag builder (pure, React-free — usable server-side)
export { buildByolTags, BYOL_TAG_KEYS, MANAGED_BY } from './tags'
export type { ByolTags, ByolTagInput } from './tags'

// Cluster placement allocation (pure, React-free — usable server-side)
export { allocateNodesBySite, validatePlacement, effectivePlacement } from './placement'
export type { SiteAllocation } from './placement'

// Types
export type {
  ByolInfrastructure,
  ByolInfrastructureManagerProps,
  ByolConfigLink,
  ByolResource,
  ByolDeployment,
  ByolDeploymentStep,
  ByolRegion,
  Tag,
  CloudProvider,
  CloudRegion,
  CloudAccount,
  FormState,
  ControlPlaneLayout,
  PlacementGranularity,
  PlacementSite,
  ClusterPlacement,
} from './types'
export {
  SINGLE_SITE_PLACEMENT,
  MIN_HEAVY_FORWARDERS,
  CONTROL_PLANE_LAYOUT_OPTIONS,
  PLACEMENT_GRANULARITY_OPTIONS,
} from './types'

// Status helpers
export {
  statusVariant,
  statusLabel,
  isRunning,
  isNotStarted,
  resourceStatusVariant,
  resourceStatusLabel,
  stepStatusVariant,
} from './status'

// Topology (also exported from the React-free root entry for server use)
export { buildByolResourcePlan, TIER_LABELS, TIER_ORDER, DEPLOYMENT_STEPS } from './topology'
export type {
  ByolResourceTier,
  ByolResourceKind,
  ByolResourcePlanItem,
  ByolResourcePlanItemWithOrder,
  ByolTopologyInput,
} from './topology'
