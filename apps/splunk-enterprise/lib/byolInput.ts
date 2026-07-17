// =============================================================================
// BYOL infrastructure request validation (pure).
//
// Extracted from server/index.ts so the coercion/validation rules — including
// the topology-authoring fields (control-plane layout, heavy forwarders, cluster
// placement) — can be unit tested without pulling in Fastify or the platform DB.
//
// Region associations (indexerRegions / searchHeadRegions) and the splunkUpgrade
// relation are intentionally NOT written here.
// =============================================================================

import { normalizeControlPlaneLayout, parsePlacement, validatePlacement } from './byolPlacement'

function toInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/** Coerce + validate an editable BYOL infrastructure record from a request body. */
export function readByol(body: any): { data: Record<string, unknown>; error?: string } {
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return { data: {}, error: 'Name is required' }
  if (name.length > 120) return { data: {}, error: 'Name must be 120 characters or fewer' }

  const deploymentType = typeof body?.deploymentType === 'string' ? body.deploymentType.trim() : 'single'
  const environmentType = typeof body?.environmentType === 'string' ? body.environmentType.trim() : ''
  // Provider name (a platform cloud-provider name, or "Self-Hosted"); no default
  // — Kubernetes is no longer a hosting option.
  const hostingType = typeof body?.hosting_type === 'string' ? body.hosting_type.trim() : ''
  // Cloud region (only meaningful for a distributed cloud deployment).
  const region = typeof body?.region === 'string' ? body.region.trim() : ''

  const indexerCount = toInt(body?.indexerCount, 1)
  const searchHeadCount = toInt(body?.searchHeadCount, 1)
  if (indexerCount < 1) return { data: {}, error: 'indexerCount must be at least 1' }
  if (searchHeadCount < 1) return { data: {}, error: 'searchHeadCount must be at least 1' }

  // "Distributed" is the multi-node Splunk topology (single instance is the other).
  const isDistributed = deploymentType === 'distributed'
  if (isDistributed) {
    if (indexerCount < 3) return { data: {}, error: 'Distributed deployments require at least 3 indexers' }
    if (searchHeadCount < 2) return { data: {}, error: 'Distributed deployments require at least 2 search heads' }
  }

  // Topology authoring — only meaningful for distributed deployments. Single
  // instance / self-hosted collapse to defaults (dedicated, one forwarder, single-site).
  const controlPlaneLayout = isDistributed ? normalizeControlPlaneLayout(body?.controlPlaneLayout) : 'dedicated'
  const heavyForwarderCount = isDistributed ? Math.max(1, toInt(body?.heavyForwarderCount, 1)) : 1
  const indexerPlacement = isDistributed ? parsePlacement(body?.indexerPlacement) : null
  const searchHeadPlacement = isDistributed ? parsePlacement(body?.searchHeadPlacement) : null
  if (isDistributed) {
    const indexerErr = validatePlacement(indexerPlacement, indexerCount)
    if (indexerErr) return { data: {}, error: `Indexer placement: ${indexerErr}` }
    const searchErr = validatePlacement(searchHeadPlacement, searchHeadCount)
    if (searchErr) return { data: {}, error: `Search head placement: ${searchErr}` }
    // Multi-region (region granularity) provisioning is not implemented yet — the
    // module places every node in the deploy region — so reject it loudly rather
    // than silently collapsing a "multi-region" plan into a single region.
    for (const [label, p] of [
      ['Indexer', indexerPlacement],
      ['Search head', searchHeadPlacement],
    ] as const) {
      if (p?.mode === 'multi-site' && p.granularity === 'region') {
        return {
          data: {},
          error: `${label} placement: multi-region placement is not available yet — use availability-zone placement (same region).`,
        }
      }
    }
  }

  // Deployment target: shared = Veltrix-hosted; dedicated/existing = BYOC (into
  // the customer's own cloud account). Defaults keep hosted behaviour unchanged.
  const networkMode = typeof body?.networkMode === 'string' ? body.networkMode.trim() : 'shared'
  if (!['shared', 'dedicated', 'existing'].includes(networkMode)) {
    return { data: {}, error: 'networkMode must be one of: shared, dedicated, existing' }
  }
  const dnsMode = typeof body?.dnsMode === 'string' ? body.dnsMode.trim() : 'managed'
  if (!['managed', 'delegated', 'private-only'].includes(dnsMode)) {
    return { data: {}, error: 'dnsMode must be one of: managed, delegated, private-only' }
  }
  const cloudAccountConnectionId =
    typeof body?.cloudAccountConnectionId === 'string' ? body.cloudAccountConnectionId.trim() : ''
  // BYOC modes must name the cloud account to deploy into.
  if ((networkMode === 'dedicated' || networkMode === 'existing') && !cloudAccountConnectionId) {
    return { data: {}, error: 'A cloud account is required when deploying into your own cloud (dedicated/existing)' }
  }

  // Compute size override; empty/whitespace → null (use the cloud default).
  const instanceTypeRaw = typeof body?.instanceType === 'string' ? body.instanceType.trim() : ''
  const instanceType = instanceTypeRaw || null

  const data: Record<string, unknown> = {
    name,
    deploymentType,
    environmentType,
    hosting_type: hostingType,
    region,
    indexerCount,
    searchHeadCount,
    networkMode,
    dnsMode,
    controlPlaneLayout,
    heavyForwarderCount,
    indexerPlacement,
    searchHeadPlacement,
    instanceType,
  }
  // cloudProviderId is optional (String?); only set when explicitly provided.
  if (typeof body?.cloudProviderId === 'string' && body.cloudProviderId.trim()) {
    data.cloudProviderId = body.cloudProviderId.trim()
  }
  if (cloudAccountConnectionId) {
    data.cloudAccountConnectionId = cloudAccountConnectionId
  }
  return { data }
}
