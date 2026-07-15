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
  FormState,
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
