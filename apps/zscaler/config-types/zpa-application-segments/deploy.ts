import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  MISSING_CUSTOMER_ID_MESSAGE,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import {
  extractApplicationSegmentSpecs,
  parsePortRanges,
  type ApplicationSegmentSpec,
  type LiveApplicationSegment,
  type PortRange,
} from './validate'

export interface ApplicationSegmentRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: {
    name?: string
    description?: string
    enabled?: boolean
    domainNames?: string[]
    segmentGroupId?: string
    serverGroups?: Array<{ id?: string }>
    tcpPortRange?: Array<{ from?: string; to?: string }>
    udpPortRange?: Array<{ from?: string; to?: string }>
    bypassType?: string
    healthReporting?: string
  }
}

/** A live object addressable by name (segment groups / server groups). */
interface LiveNamedRef {
  id?: string
  name?: string
}

/** The dependency ids + port ranges resolved for a single application segment. */
interface ResolvedRefs {
  segmentGroupId: string
  serverGroupIds: string[]
  tcpPortRange: PortRange[]
  udpPortRange: PortRange[]
}

/**
 * Deploy ZPA application segments via the Zscaler OneAPI.
 *
 * An application segment references a segment group and one or more server groups
 * by name, so deploy first lists /segmentGroup and /serverGroup and resolves each
 * referenced NAME to its id (throwing if a dependency is missing — the author must
 * create it first). Identity is the NAME (ZPA has no upsert): list /application,
 * match by name, then PUT an existing segment or POST a new one. Unlike ZIA, ZPA
 * changes apply IMMEDIATELY — there is no activation step, so a write returning
 * success is the end of the operation.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built
  if (!client.hasCustomerId) {
    return { success: false, message: MISSING_CUSTOMER_ID_MESSAGE }
  }

  const specs = extractApplicationSegmentSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ApplicationSegmentRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const [existing, segmentGroups, serverGroups] = await Promise.all([
      listApplicationSegments(client),
      listSegmentGroups(client),
      listServerGroups(client),
    ])
    const byName = new Map(existing.filter((a) => a.name).map((a) => [a.name as string, a]))
    const segByName = new Map(segmentGroups.filter((g) => g.name).map((g) => [g.name as string, g]))
    const srvByName = new Map(serverGroups.filter((g) => g.name).map((g) => [g.name as string, g]))

    for (const spec of specs) {
      const resolved = resolveRefs(spec, segByName, srvByName)
      const live = byName.get(spec.name)

      if (live && live.id != null) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          prior: {
            name: live.name,
            description: live.description ?? '',
            enabled: live.enabled ?? true,
            domainNames: live.domainNames ?? [],
            segmentGroupId: live.segmentGroupId,
            serverGroups: (live.serverGroups ?? []).map((g) => ({ id: g.id })),
            tcpPortRange: live.tcpPortRange ?? [],
            udpPortRange: live.udpPortRange ?? [],
            bypassType: live.bypassType,
            healthReporting: live.healthReporting,
          },
        })
        const res = await client.zpa('PUT', `/application/${live.id}`, { body: buildPayload(spec, resolved, live.id) })
        if (!res.ok) {
          throw new Error(`Failed to update application segment "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zpa('POST', '/application', { body: buildPayload(spec, resolved) })
        if (!res.ok) {
          throw new Error(`Failed to create application segment "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveApplicationSegment>(res.body)
        if (created?.id == null) {
          throw new Error(`Application segment "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} ZPA application segment(s) on tenant "${vanity}": ${deployed.join(', ')}`,
      artifacts: { vanity, deployedApplicationSegments: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Application segment deployment failed after ${deployed.length} of ${specs.length} segment(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedApplicationSegments: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZPA application segments; throws on a non-OK response. */
export async function listApplicationSegments(client: ZscalerClient): Promise<LiveApplicationSegment[]> {
  const res = await client.zpaGetAll<LiveApplicationSegment>('/application')
  if (!res.ok) {
    throw new Error(
      `Failed to list application segments: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** List all ZPA segment groups (dependency lookup); throws on a non-OK response. */
async function listSegmentGroups(client: ZscalerClient): Promise<LiveNamedRef[]> {
  const res = await client.zpaGetAll<LiveNamedRef>('/segmentGroup')
  if (!res.ok) {
    throw new Error(
      `Failed to list segment groups: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** List all ZPA server groups (dependency lookup); throws on a non-OK response. */
async function listServerGroups(client: ZscalerClient): Promise<LiveNamedRef[]> {
  const res = await client.zpaGetAll<LiveNamedRef>('/serverGroup')
  if (!res.ok) {
    throw new Error(
      `Failed to list server groups: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Resolve a spec's segment group + server group NAMES to live ids (throws if any is missing). */
function resolveRefs(
  spec: ApplicationSegmentSpec,
  segByName: Map<string, LiveNamedRef>,
  srvByName: Map<string, LiveNamedRef>,
): ResolvedRefs {
  const segmentGroupId = segByName.get(spec.segmentGroupName)?.id
  if (segmentGroupId == null) {
    throw new Error(
      `Segment group "${spec.segmentGroupName}" referenced by application segment "${spec.name}" was not found in the tenant — create it first`,
    )
  }

  const serverGroupIds: string[] = []
  for (const groupName of spec.serverGroupNames) {
    const id = srvByName.get(groupName)?.id
    if (id == null) {
      throw new Error(
        `Server group "${groupName}" referenced by application segment "${spec.name}" was not found in the tenant — create it first`,
      )
    }
    serverGroupIds.push(id)
  }

  return {
    segmentGroupId,
    serverGroupIds,
    tcpPortRange: parsePortRanges(spec.tcpPortRanges),
    udpPortRange: parsePortRanges(spec.udpPortRanges),
  }
}

function buildPayload(spec: ApplicationSegmentSpec, resolved: ResolvedRefs, id?: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: spec.name,
    description: spec.description ?? '',
    enabled: spec.enabled,
    domainNames: spec.domainNames,
    segmentGroupId: resolved.segmentGroupId,
    serverGroups: resolved.serverGroupIds.map((id) => ({ id })),
    tcpPortRange: resolved.tcpPortRange,
    udpPortRange: resolved.udpPortRange,
    bypassType: spec.bypassType,
    healthReporting: spec.healthReporting,
  }
  // PUT is replace-style — echo the id back so the record is fully specified.
  if (id != null) payload.id = id
  return payload
}
