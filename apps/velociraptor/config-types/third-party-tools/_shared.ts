// Shared helpers for the Velociraptor Third-Party Tools config type: pin the
// third-party binaries Velociraptor artifacts download to endpoints (e.g.
// osquery, winpmem) to a specific version + hash, a supply-chain integrity
// control. VQL runs over the gRPC API (mutual TLS); see lib/velociraptorApi.ts
// for the reused runVQL transport seam.
//
// >>> VERIFY AGAINST A LIVE VELOCIRAPTOR SERVER <<<
// The inventory VQL is the single swap point for this config type and lives
// entirely in THIS file:
//   - inventoryAddVQL()   inventory_add(tool=, version=, url=, hash=, filename=, serve_locally=)
//   - INVENTORY_VQL       inventory()   — lists every tool definition
// (vql/server/inventory.go). There is NO documented `inventory_delete` /
// `inventory_remove` plugin — a newly-added tool cannot be un-added via VQL, a
// structural limitation this config type's rollback/drift honestly surface
// rather than silently pretend to fix (see README Coverage).

import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'
import {
  createVelociraptorClient,
  resolveApiClientConfig,
  vqlQuote,
  type VelociraptorClient,
  type VqlRow,
} from '../../lib/velociraptorApi'

// --- VQL (single swap point — VERIFY every function name below) ----------------

/** List every tool definition currently in the server's inventory. VERIFY: plugin `inventory`. */
export const INVENTORY_VQL = 'SELECT * FROM inventory()'

export interface ToolDefinition {
  tool: string
  version?: string
  url?: string
  hash?: string
  filename?: string
  serveLocally: boolean
}

/**
 * Upsert (add or overwrite) a tool definition.
 * VERIFY: `inventory_add(tool=, version=, url=, hash=, filename=, serve_locally=)`
 * — whether this OVERWRITES an existing tool+version's definition or errors is
 * UNCERTAIN; this app calls it on every deploy assuming upsert. `serve_locally`
 * is rendered as VQL's bare `TRUE`/`FALSE` literal — VERIFY.
 */
export function inventoryAddVQL(def: ToolDefinition): string {
  const parts = [`tool=${vqlQuote(def.tool)}`]
  if (def.version) parts.push(`version=${vqlQuote(def.version)}`)
  if (def.url) parts.push(`url=${vqlQuote(def.url)}`)
  if (def.hash) parts.push(`hash=${vqlQuote(def.hash)}`)
  if (def.filename) parts.push(`filename=${vqlQuote(def.filename)}`)
  parts.push(`serve_locally=${def.serveLocally ? 'TRUE' : 'FALSE'}`)
  return `SELECT inventory_add(${parts.join(', ')}) AS tool FROM scope()`
}

// --- reading --------------------------------------------------------------------

/** One tool definition as read from inventory(). VERIFY columns. */
export interface LiveTool {
  tool: string
  version: string
  url: string
  hash: string
  filename: string
  serveLocally: boolean | null
}

/** Map inventory() rows into LiveTool, tolerant of column naming/casing. */
export function readTools(rows: VqlRow[]): LiveTool[] {
  return rows
    .map((row) => ({
      tool: String(row['tool'] ?? row['Tool'] ?? row['name'] ?? '').trim(),
      version: String(row['version'] ?? row['Version'] ?? '').trim(),
      url: String(row['url'] ?? row['Url'] ?? row['URL'] ?? '').trim(),
      hash: String(row['hash'] ?? row['Hash'] ?? '').trim(),
      filename: String(row['filename'] ?? row['Filename'] ?? row['FilenameOnClient'] ?? '').trim(),
      serveLocally:
        typeof row['serve_locally'] === 'boolean'
          ? (row['serve_locally'] as boolean)
          : typeof row['ServesLocally'] === 'boolean'
            ? (row['ServesLocally'] as boolean)
            : null,
    }))
    .filter((t) => t.tool)
}

/** Find a live tool by exact (case-insensitive) tool name — the practical identity. */
export function findTool(tools: LiveTool[], tool: string): LiveTool | null {
  const n = tool.trim().toLowerCase()
  if (!n) return null
  return tools.find((t) => t.tool.toLowerCase() === n) ?? null
}

// --- transport ----------------------------------------------------------------

/** Read the VQL timeout (seconds) from installation settings, defaulting to 30s. */
export function vqlTimeoutMs(settings: Record<string, unknown> | undefined): number {
  const raw = settings?.['vql_timeout_seconds']
  const seconds = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000
}

/** Build a Velociraptor client (gRPC/mTLS) from the connection's api-client config. */
export async function buildClient(
  component: ComponentRef,
  credential: CredentialRef | null | undefined,
  connectivity: ConnectivityRef | null | undefined,
  settings: Record<string, unknown> | undefined,
): Promise<VelociraptorClient> {
  const config = resolveApiClientConfig(credential, component, connectivity)
  return createVelociraptorClient(config, { timeoutMs: vqlTimeoutMs(settings) })
}
