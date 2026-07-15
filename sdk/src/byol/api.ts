// =============================================================================
// BYOL fetch + formatting helpers. All calls go through the SDK's authFetch so
// they carry the tenant's auth against the app's own `/byol` routes.
// =============================================================================

import { authFetch } from '../client'
import type { ByolInfrastructure, ByolResource, ByolDeployment } from './types'

/** Best-effort extraction of an error message from a failed Response. */
export async function errorText(res: Response): Promise<string> {
  return res
    .json()
    .then((b: { error?: string }) => b?.error || `HTTP ${res.status}`)
    .catch(() => `HTTP ${res.status}`)
}

export function formatDate(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

export function formatDateTime(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await errorText(res))
  return res.json() as Promise<T>
}

/** Re-fetch a single infrastructure record. */
export function getInfra(apiBase: string, id: string): Promise<ByolInfrastructure> {
  return authFetch(`${apiBase}/${id}`).then((r) => json<ByolInfrastructure>(r))
}

export function getResources(apiBase: string, id: string): Promise<ByolResource[]> {
  return authFetch(`${apiBase}/${id}/resources`).then((r) => json<ByolResource[]>(r))
}

export function getDeployments(apiBase: string, id: string): Promise<ByolDeployment[]> {
  return authFetch(`${apiBase}/${id}/deployments`).then((r) => json<ByolDeployment[]>(r))
}

/** Request an end-to-end deploy. Returns the updated infra + the new run. */
export function deployInfra(
  apiBase: string,
  id: string,
): Promise<{ infrastructure: ByolInfrastructure; deployment: ByolDeployment; resources: ByolResource[] }> {
  return authFetch(`${apiBase}/${id}/deploy`, { method: 'POST' }).then((r) =>
    json<{ infrastructure: ByolInfrastructure; deployment: ByolDeployment; resources: ByolResource[] }>(r),
  )
}

/** Tear down every resource in the plan. */
export function destroyInfra(apiBase: string, id: string): Promise<{ infrastructure: ByolInfrastructure }> {
  return authFetch(`${apiBase}/${id}/destroy`, { method: 'POST' }).then((r) =>
    json<{ infrastructure: ByolInfrastructure }>(r),
  )
}

/** Start / stop / restart a running environment. */
export function lifecycleInfra(
  apiBase: string,
  id: string,
  action: 'start' | 'stop' | 'restart',
): Promise<ByolInfrastructure> {
  return authFetch(`${apiBase}/${id}/${action}`, { method: 'POST' }).then((r) => json<ByolInfrastructure>(r))
}
