// ========================================================================
// Inventory — the deployment targets an app can deploy configuration to.
//
// "Inventory" is the app-facing name for the platform's *components*: the
// servers (hostname/port), domains, and IP/CIDR ranges a customer has
// registered as deploy targets. These helpers are a typed, convenient
// surface over the platform's components API (/api/components), enriched
// with `domains` and `ipRanges`.
//
// Framework-free (no React) — safe to import from any client code. Every
// call goes through the same `authFetch` the '/client' subpath exports, so
// requests carry the platform's Authorization header. Non-2xx responses are
// surfaced as thrown Errors carrying the platform's error text.
// ========================================================================

import type { InventoryItem, InventoryItemInput } from '../types/platform'
import { authFetch } from './index'

/** Base route for the platform's components (inventory) API. */
const INVENTORY_API = '/api/components'

/**
 * Loosely-typed shape of a raw component as returned by the platform, before
 * it is normalized down to the {@link InventoryItem} surface.
 */
interface RawInventoryItem {
  id: string
  hostname?: string
  port?: string
  type?: string[]
  domains?: string[]
  ipRanges?: string[]
  tags?: Array<{ id: string; name: string }>
  connectivityProviderId?: string | null
  credentialId?: string | null
}

/** Build an Error from a non-2xx response, preferring the platform's message. */
async function inventoryError(res: Response): Promise<Error> {
  const text = await res.text().catch(() => '')
  if (text) {
    try {
      const body = JSON.parse(text) as { error?: string; message?: string }
      const message = body?.error ?? body?.message
      if (message) return new Error(message)
    } catch {
      // Body was not JSON — fall through and use the raw text.
    }
    return new Error(text)
  }
  return new Error(`HTTP ${res.status}`)
}

/** Normalize a raw platform component into the typed InventoryItem surface. */
function toInventoryItem(raw: RawInventoryItem): InventoryItem {
  return {
    id: String(raw.id),
    hostname: raw.hostname ?? '',
    port: raw.port ?? undefined,
    type: Array.isArray(raw.type) ? raw.type : undefined,
    domains: Array.isArray(raw.domains) ? raw.domains : [],
    ipRanges: Array.isArray(raw.ipRanges) ? raw.ipRanges : [],
    tags: Array.isArray(raw.tags)
      ? raw.tags.map((tag) => ({ id: String(tag.id), name: String(tag.name) }))
      : [],
    connectivityProviderId: raw.connectivityProviderId ?? null,
    credentialId: raw.credentialId ?? null,
  }
}

/**
 * A platform Tool. Each installed app is upserted as a Tool keyed by its
 * manifest `name`, and inventory items (components) belong to a tool.
 */
export interface Tool {
  id: string
  name: string
  vendor?: string
}

/**
 * Resolve the platform Tool for an app by its manifest name (the platform
 * upserts `Tool.name === app name`). The tool id is required by the platform
 * when creating an inventory item, so call this once and pass the id as
 * `toolId` to {@link addInventoryItem}. Returns null when no tool matches.
 *
 * GET /api/tools (paginated — `{ data, pagination }` — or a bare array; both are
 * handled). We MUST filter server-side by name: the list is paginated (default 20,
 * ordered by createdAt) so once a tenant has enough apps installed, a bare
 * client-side find over just the first page silently misses a real tool whose row
 * fell to a later page — surfacing a false "no <app> tool found, install the app
 * first" error for an app that is in fact installed. `search` is a case-insensitive
 * contains match, so we still exact-match `tool.name === name` on the result.
 */
export async function resolveTool(name: string): Promise<Tool | null> {
  const res = await authFetch(`/api/tools?search=${encodeURIComponent(name)}&limit=100`)
  if (!res.ok) throw await inventoryError(res)
  const body = (await res.json()) as unknown
  const tools: Tool[] = Array.isArray(body)
    ? (body as Tool[])
    : Array.isArray((body as { data?: unknown })?.data)
      ? ((body as { data: Tool[] }).data)
      : []
  return tools.find((tool) => tool.name === name) ?? null
}

/** List the customer's inventory (deployment targets). GET /api/components */
export async function listInventory(): Promise<InventoryItem[]> {
  const res = await authFetch(INVENTORY_API)
  if (!res.ok) throw await inventoryError(res)
  const data = (await res.json()) as RawInventoryItem[]
  return Array.isArray(data) ? data.map(toInventoryItem) : []
}

/** Add a new inventory item (deployment target). POST /api/components */
export async function addInventoryItem(input: InventoryItemInput): Promise<InventoryItem> {
  const res = await authFetch(INVENTORY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw await inventoryError(res)
  return toInventoryItem((await res.json()) as RawInventoryItem)
}

/** Update an existing inventory item. PUT /api/components/:id */
export async function updateInventoryItem(
  id: string,
  input: InventoryItemInput,
): Promise<InventoryItem> {
  const res = await authFetch(`${INVENTORY_API}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw await inventoryError(res)
  return toInventoryItem((await res.json()) as RawInventoryItem)
}

/** Remove an inventory item. DELETE /api/components/:id */
export async function removeInventoryItem(id: string): Promise<void> {
  const res = await authFetch(`${INVENTORY_API}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  // 204 No Content is the platform's success response for delete.
  if (!res.ok && res.status !== 204) throw await inventoryError(res)
}
