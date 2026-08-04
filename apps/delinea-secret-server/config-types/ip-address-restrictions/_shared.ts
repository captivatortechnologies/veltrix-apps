// Shared helpers for the Secret Server IP Address Restrictions config type
// (deploy + rollback + drift + health) — also known as "allowed IP ranges":
// a named CIDR/IP range that can be attached to users or groups (Admin >
// Security > IP Address Restrictions) to restrict where they may log on from.
// This config type manages the named ranges themselves; attaching a
// restriction to a user or group is out of scope (see the README Coverage
// section). Shapes follow the Secret Server v1 REST API
// (/api/v1/ipaddress-restrictions).
//
// VERIFIED against the Delinea/Thycotic PowerShell module source
// (thycotic-ps/thycotic.secretserver — New/Update/Search-TssIpRestriction):
//   search  GET  /api/v1/ipaddress-restrictions
//   create  POST /api/v1/ipaddress-restrictions        { name, range }
//   update  PUT  /api/v1/ipaddress-restrictions/{id}   { id, name, range }
// No secret material of any kind — a name and a CIDR/IP string. Requires
// Secret Server 10.9.000064+.

import { listAllRecords, type SecretServerClient } from '../../lib/secretServerApi'

/** One restriction as returned by GET /api/v1/ipaddress-restrictions. */
export interface LiveIpRestriction {
  id?: number | string
  name?: string
  range?: string
  [key: string]: unknown
}

/** One restriction declared by a canvas item. */
export interface IpRestrictionSpec {
  name: string
  range: string
  comment: string
}

/** A canvas item shape (id/name optional; only fields are read). */
export interface CanvasItemLike {
  fields: Record<string, unknown>
}

export function restrictionNameOf(r: LiveIpRestriction): string {
  return String(r.name ?? '')
}

/** A live restriction's numeric id, or null when absent / non-numeric. */
export function restrictionIdOf(r: LiveIpRestriction): number | null {
  const raw = r.id
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** Map canvas items to IP restriction specs. */
export function extractIpRestrictionSpecs(items: CanvasItemLike[]): IpRestrictionSpec[] {
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      name: String(f.name ?? '').trim(),
      range: String(f.range ?? '').trim(),
      comment: String(f.comment ?? '').trim(),
    }
  })
}

/**
 * List every IP address restriction across every page. The Secret Server
 * search endpoint takes no name filter, so this always fetches the full list
 * — callers match by name client-side. Throws on a non-OK response.
 */
export async function listIpRestrictions(client: SecretServerClient): Promise<LiveIpRestriction[]> {
  return listAllRecords<LiveIpRestriction>(client, '/ipaddress-restrictions')
}

/** Find a live restriction by name (case-insensitive). */
export function findIpRestrictionByName(restrictions: LiveIpRestriction[], name: string): LiveIpRestriction | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return restrictions.find((r) => restrictionNameOf(r).trim().toLowerCase() === n) ?? null
}

/** Body for POST /api/v1/ipaddress-restrictions (create). */
export function buildIpRestrictionCreateBody(spec: IpRestrictionSpec): Record<string, unknown> {
  return { name: spec.name, range: spec.range }
}

/** Body for PUT /api/v1/ipaddress-restrictions/{id} (update). Carries the id. */
export function buildIpRestrictionUpdateBody(spec: IpRestrictionSpec, existing: LiveIpRestriction): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, range: spec.range }
  const id = restrictionIdOf(existing)
  if (id !== null) body.id = id
  return body
}

/** Restore body for a prior restriction — only the fields this app manages. */
export function buildIpRestrictionRestoreBody(prior: LiveIpRestriction): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (prior.name !== undefined) body.name = prior.name
  if (prior.range !== undefined) body.range = prior.range
  if (prior.id !== undefined) body.id = prior.id
  return body
}
