// =============================================================================
// Platform network-allocation client (app-owned transport).
//
// Thin HTTP client for the GENERIC platform IPAM service (built in Phase 2a),
// which owns the shared per-(provider, region) Network, the per-customer CIDR
// blocks, and the GLOBAL subnet ledger. The app never allocates CIDRs itself —
// overlap detection must be global across every tenant and app, so it lives in
// the platform. This module only speaks its two-endpoint contract:
//
//   POST /api/network/allocations/peek  → dry-run: "what subnet WOULD I get"
//     body { provider, region, customerId, prefix? }
//     → { networkRef, subnetCidr, customerBlock }
//     Used by GET /byol/:id/plan (side-effect-free, no commit).
//
//   POST /api/network/allocations       → atomic reserve (409 on collision)
//     body { provider, region, customerId, appId, infrastructureId, stackId?, prefix? }
//     → { allocationId, networkRef, subnetCidr, customerBlock }
//     Used by POST /byol/:id/deploy (commit).
//
// Configuration is env-driven (same pattern as the S3 helpers): the base URL of
// the platform's internal API is read from VELTRIX_NETWORK_API_URL, with an
// optional service token in VELTRIX_NETWORK_API_TOKEN. When the base URL is
// unset the allocator is treated as "not configured" and callers degrade
// gracefully (Phase 2a may not be deployed yet).
// =============================================================================

/** Raised when the allocator reports a subnet collision (HTTP 409) on reserve. */
export class NetworkAllocationConflictError extends Error {
  constructor(message = 'Subnet allocation conflict') {
    super(message)
    this.name = 'NetworkAllocationConflictError'
  }
}

/** Raised for any other non-OK response / transport failure. */
export class NetworkAllocationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NetworkAllocationError'
  }
}

/** Dry-run peek result — no allocation is committed. */
export interface NetworkAllocationPeek {
  networkRef: string
  subnetCidr: string
  customerBlock: string
}

/** Committed allocation result — carries the ledger row id for teardown/release. */
export interface NetworkAllocation extends NetworkAllocationPeek {
  allocationId: string
}

export interface PeekInput {
  provider: string
  region: string
  customerId: string
  prefix?: number
}

export interface ReserveInput extends PeekInput {
  appId: string
  infrastructureId: string
  stackId?: string
}

/** Trimmed base URL of the platform network API, or null when not configured. */
function baseUrl(): string | null {
  const raw = process.env.VELTRIX_NETWORK_API_URL
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed ? trimmed.replace(/\/+$/, '') : null
}

/** Whether the platform network allocator is wired for this deployment. */
export function isNetworkApiConfigured(): boolean {
  return baseUrl() !== null
}

// --- non-union response parse helpers (defensive; the service owns the shape) --

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function requireString(value: unknown, field: string): string {
  const s = asString(value).trim()
  if (!s) throw new NetworkAllocationError(`network allocator response missing "${field}"`)
  return s
}

async function post(path: string, body: Record<string, unknown>): Promise<unknown> {
  const base = baseUrl()
  if (!base) throw new NetworkAllocationError('network allocator is not configured (VELTRIX_NETWORK_API_URL unset)')

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = process.env.VELTRIX_NETWORK_API_TOKEN
  if (typeof token === 'string' && token.trim()) headers.Authorization = `Bearer ${token.trim()}`

  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  if (res.status === 409) throw new NetworkAllocationConflictError()
  if (!res.ok) throw new NetworkAllocationError(`network allocator responded ${res.status}`)
  return res.json()
}

/** Drop keys whose value is undefined so the request body stays minimal. */
function compact(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body)) if (v !== undefined) out[k] = v
  return out
}

/** Dry-run: preview the subnet the allocator would carve. Commits nothing. */
export async function peekAllocation(input: PeekInput): Promise<NetworkAllocationPeek> {
  const raw = (await post('/api/network/allocations/peek', compact({ ...input }))) as Record<string, unknown>
  return {
    networkRef: requireString(raw.networkRef, 'networkRef'),
    subnetCidr: requireString(raw.subnetCidr, 'subnetCidr'),
    customerBlock: asString(raw.customerBlock),
  }
}

/** Atomically reserve a subnet. Throws NetworkAllocationConflictError on 409. */
export async function reserveAllocation(input: ReserveInput): Promise<NetworkAllocation> {
  const raw = (await post('/api/network/allocations', compact({ ...input }))) as Record<string, unknown>
  return {
    allocationId: requireString(raw.allocationId, 'allocationId'),
    networkRef: requireString(raw.networkRef, 'networkRef'),
    subnetCidr: requireString(raw.subnetCidr, 'subnetCidr'),
    customerBlock: asString(raw.customerBlock),
  }
}
