import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// CyberArk Platform Session Management Policy — validate + shared spec
// extraction.
//
// GET/PUT /Platforms/Targets/{platformId}/PrivilegedSessionManagement/ is a
// SINGLETON PER PLATFORM (not a create/delete-able collection — every valid
// platform has exactly one, read/write) that governs which PSM server and
// connectors are used to broker privileged sessions for accounts on that
// platform. This corrects the 1.2.0 CHANGELOG's blanket claim that "Master
// Policy / per-platform privileged access workflows are read-only over
// REST" — the session-management slice of that surface IS writable via this
// endpoint. The OTHER privileged-access-workflow settings (dual control,
// exclusive access, one-time passwords, reason-for-access) remain unconfirmed
// writable in this pass — see README "Coverage".
//
// One canvas item manages ONE platform's policy, identified by platform_id
// (mirrors the ordered-singleton-per-network shape cisco-meraki's L3/L7
// firewall rules use for one network's ruleset). GET always succeeds for a
// valid platform id, so deploy always reads-then-writes; there is no
// create/delete.
//
// NO SECRET MATERIAL: a PSM server id/name and a connector's enabled flag are
// operational routing settings, never credentials.
// =============================================================================

export interface SessionPolicySpec {
  sectionName: string
  platformId: string
  psmServerId: string
  psmServerName: string
  /** connectorId -> enabled, from a `keyvalue` canvas field ("true"/"false" strings). */
  psmConnectors: Record<string, boolean>
}

/** One connector entry as CyberArk returns/accepts it. */
export interface LivePsmConnector {
  PSMConnectorID?: string
  Enabled?: boolean
}

/** Shape of a platform's session-management policy (only fields we manage). */
export interface LiveSessionPolicy {
  PSMServerId?: string
  PSMServerName?: string
  PSMConnectors?: LivePsmConnector[]
}

/** Each canvas item describes one platform's session-management policy. */
export function extractSessionPolicySpecs(canvas: CanvasSnapshot): SessionPolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      platformId: typeof fields.platform_id === 'string' ? fields.platform_id.trim() : '',
      psmServerId: typeof fields.psm_server_id === 'string' ? fields.psm_server_id.trim() : '',
      psmServerName: typeof fields.psm_server_name === 'string' ? fields.psm_server_name.trim() : '',
      psmConnectors: readConnectorMap(fields.psm_connectors),
    }
  })
}

/** Read a `keyvalue` canvas field into a connectorId -> enabled map. Tolerant of a plain object too. */
function readConnectorMap(value: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.trim()
    if (!key) continue
    out[key] = v === true || v === 'true'
  }
  return out
}

/** Convert a live PSMConnectors array to the same connectorId -> enabled shape. */
export function liveConnectorMap(connectors: LivePsmConnector[] | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const c of connectors ?? []) {
    if (typeof c.PSMConnectorID === 'string' && c.PSMConnectorID) out[c.PSMConnectorID] = c.Enabled === true
  }
  return out
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate session-policy configurations: platform_id and psm_server_id are
 * required (PUT replaces the whole policy, so a PSM server must always be
 * named); the platform_id natural key is unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSessionPolicySpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.platformId) errors.push({ field: `${prefix}.platform_id`, message: 'Platform ID is required', code: 'required' })
    if (!spec.psmServerId) errors.push({ field: `${prefix}.psm_server_id`, message: 'PSM server ID is required', code: 'required' })

    if (spec.platformId) {
      const key = spec.platformId.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.platform_id`,
          message: `Duplicate platform "${spec.platformId}" — each platform's session policy may only be declared once`,
          code: 'duplicate_platform',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
