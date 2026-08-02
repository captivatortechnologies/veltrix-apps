import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCheckpointClient,
  checkpointErrorMessage,
  isNotFoundError,
  MAX_PAGE_SIZE,
  type CheckpointClient,
} from '../../lib/checkpointApi'
import { liveTagNames } from '../lib/checkpointShared'
import {
  extractServiceSpecs,
  serviceKey,
  SERVICE_COMMANDS,
  type LiveService,
  type ServiceProtocol,
  type ServiceSpec,
} from './validate'

export interface RollbackEntry {
  itemId?: string
  /** name is the identity Check Point service objects are matched on (within their protocol). */
  name: string
  protocol: ServiceProtocol
  /** Whether the service existed before THIS deploy — set- (true) vs add- (false). */
  existed: boolean
  /** Prior managed body, captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
}

/** Build the add-/set-service-{tcp,udp} request body for a declared spec. */
export function buildServiceBody(spec: ServiceSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, port: spec.port }
  if (spec.sourcePort) body['source-port'] = spec.sourcePort
  if (spec.comments) body.comments = spec.comments
  if (spec.color) body.color = spec.color
  if (spec.tags.length > 0) body.tags = spec.tags
  return body
}

/** Snapshot a live service's managed fields into a set-compatible body, for rollback. */
export function snapshotLive(live: LiveService): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name }
  if (live.port != null) body.port = live.port
  if (live['source-port'] != null) body['source-port'] = live['source-port']
  if (live.comments) body.comments = live.comments
  if (live.color) body.color = live.color
  const tags = liveTagNames(live.tags)
  if (tags.length > 0) body.tags = tags
  return body
}

/** Page through show-services-{tcp,udp} (max 500/page) for one protocol's namespace. */
export async function listAllServices(client: CheckpointClient, protocol: ServiceProtocol): Promise<LiveService[]> {
  const services: LiveService[] = []
  const command = SERVICE_COMMANDS[protocol].showAll
  let offset = 0
  for (;;) {
    const res = await client.call<{ objects?: LiveService[]; total?: number }>(command, {
      limit: MAX_PAGE_SIZE,
      offset,
      'details-level': 'standard',
    })
    if (!res.ok) throw new Error(`${command} failed: ${checkpointErrorMessage(res)}`)
    const objects = res.data?.objects ?? []
    services.push(...objects)
    const total = res.data?.total ?? objects.length
    offset += objects.length
    if (objects.length === 0 || offset >= total) break
  }
  return services
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

/**
 * Deploy Check Point TCP/UDP service objects via the Management API.
 *
 * Identity is the service `name` WITHIN its declared protocol's namespace —
 * TCP and UDP services are reconciled through entirely different command
 * families (add-service-tcp vs add-service-udp, etc.), listed separately
 * (show-services-tcp / show-services-udp), one list call per protocol
 * actually declared. Services THIS app created previously but no longer
 * declares are removed. The whole reconciliation runs inside ONE session:
 * publish on success, discard the whole session on any error.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, host } = built

  const login = await client.login()
  if (login.error) return { success: false, message: login.error }

  const specs = extractServiceSpecs(ctx.canvas).filter((s) => s.name)
  const entries: RollbackEntry[] = []
  let created = 0
  let updated = 0
  let deleted = 0

  try {
    const liveByProtocol = new Map<ServiceProtocol, Map<string, LiveService>>()
    for (const protocol of ['tcp', 'udp'] as const) {
      if (!specs.some((s) => s.protocol === protocol)) continue
      const live = await listAllServices(client, protocol)
      liveByProtocol.set(protocol, new Map(live.filter((s) => s.name).map((s) => [serviceKey(s.name as string), s])))
    }
    const prior = await loadPriorEntries(ctx)

    for (const spec of specs) {
      const commands = SERVICE_COMMANDS[spec.protocol]
      const match = liveByProtocol.get(spec.protocol)?.get(serviceKey(spec.name)) ?? null
      const body = buildServiceBody(spec)

      if (match) {
        const res = await client.call(commands.set, body)
        if (!res.ok) throw new Error(`${commands.set} "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({ itemId: spec.itemId, name: spec.name, protocol: spec.protocol, existed: true, prior: snapshotLive(match) })
        updated++
      } else {
        const res = await client.call(commands.add, body)
        if (!res.ok) throw new Error(`${commands.add} "${spec.name}" failed: ${checkpointErrorMessage(res)}`)
        entries.push({ itemId: spec.itemId, name: spec.name, protocol: spec.protocol, existed: false })
        created++
      }
    }

    const declaredKeys = new Set(specs.map((s) => `${s.protocol}::${serviceKey(s.name)}`))
    for (const p of prior) {
      if (p.existed || declaredKeys.has(`${p.protocol}::${serviceKey(p.name)}`)) continue
      const commands = SERVICE_COMMANDS[p.protocol]
      const res = await client.call(commands.delete, { name: p.name })
      if (!res.ok && !isNotFoundError(res)) {
        throw new Error(`${commands.delete} "${p.name}" failed: ${checkpointErrorMessage(res)}`)
      }
      deleted++
    }

    const publish = await client.publish()
    if (!publish.ok) throw new Error(`publish failed: ${checkpointErrorMessage(publish)}`)

    await client.logout()
    return {
      success: true,
      message:
        `Reconciled ${specs.length} Check Point service object(s) on ${host}: ` +
        `${created} created, ${updated} updated, ${deleted} removed.`,
      artifacts: { host, created, updated, deleted },
      rollbackData: { entries },
    }
  } catch (error) {
    await client.discard()
    await client.logout()
    return {
      success: false,
      message: `Deploy failed — session changes were discarded: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
