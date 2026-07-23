// ============================================================================
// Deploy API — thin wrappers over the platform's configuration-canvas + pipeline
// REST endpoints, used by `veltrix deploy`. Every call authenticates with the
// stored API key (via api.mjs). The full flow is:
//   create canvas → validate → submit for approval → (human approves) → deploy
//   → poll deployment.
// Approval is ALWAYS required for an API-driven deploy: a brand-new canvas is
// DRAFT, submit-for-approval moves it to pending, and the pipeline refuses to
// deploy anything not APPROVED — so the CLI never self-approves.
// ============================================================================

import { apiRequest } from './api.mjs'

/** GET /api/environments — environments are Tags; each has { id (Tag id), name }. */
export async function listEnvironments(profile) {
  const data = await apiRequest(profile, 'GET', 'api/environments/')
  return Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : []
}

/** GET /api/users — tenant users, for resolving approver emails → ids. */
export async function listUsers(profile) {
  const data = await apiRequest(profile, 'GET', 'api/users')
  return Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.users) ? data.users : []
}

/** POST /api/configuration-canvas — create a DRAFT canvas. Returns the canvas ({ id, status, version }). */
export async function createCanvas(profile, body) {
  return apiRequest(profile, 'POST', 'api/configuration-canvas/', body)
}

/** GET /api/configuration-canvas/:id — read a canvas (for status polling). */
export async function getCanvas(profile, id) {
  return apiRequest(profile, 'GET', `api/configuration-canvas/${encodeURIComponent(id)}`)
}

/** POST /api/pipeline/canvas/:id/validate — run the config type's validate handler. */
export async function validateCanvas(profile, id) {
  return apiRequest(profile, 'POST', `api/pipeline/canvas/${encodeURIComponent(id)}/validate`)
}

/** POST /api/configuration-canvas/:id/submit-for-approval — { approverIds, environmentTagIds?, comment? }. */
export async function submitForApproval(profile, id, body) {
  return apiRequest(profile, 'POST', `api/configuration-canvas/${encodeURIComponent(id)}/submit-for-approval`, body)
}

/** POST /api/pipeline/canvas/:id/deploy — { environmentId, strategy? }. Returns { deploymentId }. */
export async function deployCanvas(profile, id, body) {
  return apiRequest(profile, 'POST', `api/pipeline/canvas/${encodeURIComponent(id)}/deploy`, body)
}

/** GET /api/pipeline/deployments/:deploymentId — status + logs. */
export async function getDeployment(profile, deploymentId) {
  return apiRequest(profile, 'GET', `api/pipeline/deployments/${encodeURIComponent(deploymentId)}`)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True when a value already looks like a UUID (so no name→id lookup is needed). */
export function isUuid(value) {
  return UUID_RE.test(String(value))
}

/**
 * Resolve an environment reference (a name OR a Tag id) to its Tag id.
 * A value that already looks like a UUID is trusted as-is; otherwise it is
 * matched against the environment list by name (case-insensitive).
 */
export function resolveEnvironmentId(ref, environments) {
  if (UUID_RE.test(ref)) return ref
  const match = environments.find((e) => String(e.name).toLowerCase() === String(ref).toLowerCase())
  return match ? match.id : null
}

/**
 * Resolve approver references (emails OR user ids) to user ids. UUIDs pass
 * through; everything else is matched against the user list by email
 * (case-insensitive). Returns { ids, unresolved }.
 */
export function resolveApproverIds(refs, users) {
  const ids = []
  const unresolved = []
  for (const ref of refs) {
    if (UUID_RE.test(ref)) {
      ids.push(ref)
      continue
    }
    const match = users.find((u) => String(u.email).toLowerCase() === String(ref).toLowerCase())
    if (match) ids.push(match.id)
    else unresolved.push(ref)
  }
  return { ids, unresolved }
}

/** Canvas statuses from which the pipeline will accept a deploy. */
export const DEPLOYABLE_STATUSES = new Set(['APPROVED', 'DEPLOYED', 'DEPLOYMENT_FAILED', 'ROLLED_BACK'])
/** Terminal deployment statuses (stop polling). */
export const TERMINAL_DEPLOYMENT_STATUSES = new Set(['DEPLOYED', 'FAILED', 'CANCELLED', 'ROLLED_BACK'])
