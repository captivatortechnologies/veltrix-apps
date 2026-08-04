// =============================================================================
// Shared spec/validation/status helpers reused across every Check Point config
// type. Kept here — not duplicated per config type, not cross-imported
// between sibling config type folders — so a fix (e.g. a better IPv6
// matcher) lands everywhere at once.
// =============================================================================

import type { ComponentConfigStatus, ConfigStatus, PipelineContext } from '@veltrixsecops/app-sdk'

/** Read a canvas value that may be a `tags` array, a single string, or a comma list. */
export function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** An object's logical identity: its name, case-insensitive and trimmed. */
export function objectKey(name: string): string {
  return name.trim().toLowerCase()
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function isValidIpv4(value: string): boolean {
  const m = IPV4_RE.exec(value)
  return !!m && [1, 2, 3, 4].every((i) => Number(m[i]) <= 255)
}

// A pragmatic (not exhaustively RFC 4291-complete) IPv6 matcher: full and
// zero-compressed ("::") forms, including an embedded IPv4 tail and zone id.
const IPV6_RE =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]+|::(ffff(:0{1,4})?:)?((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9]))$/

export function isValidIpv6(value: string): boolean {
  return IPV6_RE.test(value)
}

/** Flatten a live member list (plain strings or { name } object summaries) to names. */
export function liveTagNames(tags: Array<string | { name?: string }> | undefined): string[] {
  if (!Array.isArray(tags)) return []
  return tags
    .map((t) => (typeof t === 'string' ? t : t?.name))
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
}

/** Case-insensitive set-equality for two name/id lists. */
export function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a.map((s) => s.toLowerCase()))
  return b.every((s) => setA.has(s.toLowerCase()))
}

/** Deep, key-order-independent JSON serialization — for cheap structural equality in drift diffs. */
export function canonicalObject(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.keys(v as Record<string, unknown>)
            .sort()
            .reduce<Record<string, unknown>>((o, k) => {
              o[k] = sort((v as Record<string, unknown>)[k])
              return o
            }, {})
        : v
  return JSON.stringify(sort(value))
}

// --- Rulebase position (access-rules AND nat-rules) ---------------------------

/**
 * The 4 position anchors `add-access-rule`/`add-nat-rule` (and their
 * `new-position` update equivalent) document — verified identical between
 * both rule types against the Terraform provider's
 * resource_checkpoint_management_access_rule.go and
 * resource_checkpoint_management_nat_rule.go: top/bottom are absolute
 * strings; above/below reference another rule or section BY NAME.
 */
export const RULE_POSITIONS = ['top', 'bottom', 'above', 'below'] as const
export type RulePosition = (typeof RULE_POSITIONS)[number]

export interface PositionedSpec {
  position: RulePosition
  /** Required when position is "above" or "below": the rule/section name to position relative to. */
  positionAnchor: string
}

/**
 * Build the `position` (create) / `new-position` (update) payload value.
 * "above"/"below" reference another rule/section BY NAME, which must already
 * exist — either pre-existing, or an earlier item in the SAME deploy (callers
 * apply specs in canvas declaration order for exactly this reason).
 */
export function buildPositionPayload(spec: PositionedSpec): unknown {
  if (spec.position === 'top') return 'top'
  if (spec.position === 'bottom') return 'bottom'
  return { [spec.position]: spec.positionAnchor }
}

// --- getStatus (identical across every config type) ---------------------------

/**
 * Every Check Point config type reports status the same way: whether the
 * canvas has a SUCCEEDED deployment, and — if so — one ComponentConfigStatus
 * per registered checkpoint-management component. Reads only the platform
 * data API; never calls the Management API itself.
 */
export async function checkpointGetStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  const { canvas, platform } = ctx
  const latestDeployment = await platform.getLatestDeployment(canvas.canvasId, { status: 'SUCCEEDED' })

  if (!latestDeployment) {
    return { deployed: false, version: String(canvas.version), lastDeployedAt: '', componentStatuses: [] }
  }

  const components = await platform.listComponents({ types: ['checkpoint-management'] })
  const componentStatuses: ComponentConfigStatus[] = components.map((comp) => ({
    componentId: comp.id,
    hostname: comp.hostname,
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latestDeployment.completedAt || '',
    healthy: latestDeployment.healthScore != null ? latestDeployment.healthScore >= 80 : undefined,
    healthScore: latestDeployment.healthScore ?? undefined,
  }))

  return {
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latestDeployment.completedAt || latestDeployment.startedAt,
    componentStatuses,
  }
}
