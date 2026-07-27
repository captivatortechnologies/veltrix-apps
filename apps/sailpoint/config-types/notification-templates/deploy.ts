import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import {
  compositeKey,
  extractNotificationTemplateSpecs,
  type LiveNotificationTemplate,
  type NotificationTemplateSpec,
} from './validate'

const BASE = '/beta/notification-templates'
const BULK_DELETE = '/beta/notification-templates/bulk-delete'

export interface RollbackEntry {
  itemId?: string
  key: string
  medium: string
  locale: string
  existed: boolean
  prior?: Record<string, unknown>
}

/** Body for createNotificationTemplate. Deprecated header/footer are omitted. */
export function buildBody(spec: NotificationTemplateSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    key: spec.key,
    medium: spec.medium,
    locale: spec.locale,
    subject: spec.subject,
    body: spec.body,
  }
  if (spec.name) body.name = spec.name
  if (spec.from) body.from = spec.from
  if (spec.replyTo) body.replyTo = spec.replyTo
  if (spec.description) body.description = spec.description
  return body
}

function snapshot(live: LiveNotificationTemplate): Record<string, unknown> {
  const body: Record<string, unknown> = {
    key: live.key,
    medium: live.medium,
    locale: live.locale,
    subject: live.subject ?? '',
    body: live.body ?? '',
  }
  if (live.name) body.name = live.name
  if (live.from) body.from = live.from
  if (live.replyTo) body.replyTo = live.replyTo
  if (live.description) body.description = live.description
  return body
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

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildIscClient(cred, settings)

  const specs = extractNotificationTemplateSpecs(ctx.canvas).filter((s) => s.key)

  const listed = await client.getAll<LiveNotificationTemplate>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list notification templates: ${iscErrorMessage(listed.lastError!)}` }
  const liveByComposite = new Map<string, LiveNotificationTemplate>()
  for (const t of listed.items) {
    if (t.key && t.medium && t.locale) liveByComposite.set(compositeKey(t.key, t.medium, t.locale), t)
  }

  const prior = await loadPriorEntries(ctx)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const ck = compositeKey(spec.key, spec.medium, spec.locale)
    const live = liveByComposite.get(ck) ?? null
    // Create replaces the custom override for this key+medium+locale.
    const resp = await client.post(BASE, buildBody(spec))
    if (!resp.ok) {
      failures.push(`${spec.key} (${spec.medium}/${spec.locale}): ${iscErrorMessage(resp)}`)
      continue
    }
    entries.push({ itemId: spec.itemId, key: spec.key, medium: spec.medium, locale: spec.locale, existed: !!live, prior: live ? snapshot(live) : undefined })
  }

  // Reconcile: bulk-delete templates THIS app created but no longer declares.
  const declared = new Set(specs.map((s) => compositeKey(s.key, s.medium, s.locale)))
  const kept = new Set(entries.map((e) => compositeKey(e.key, e.medium, e.locale)))
  const toDelete = prior
    .filter((p) => !p.existed && !kept.has(compositeKey(p.key, p.medium, p.locale)) && !declared.has(compositeKey(p.key, p.medium, p.locale)))
    .map((p) => ({ key: p.key, medium: p.medium, locale: p.locale }))
  if (toDelete.length > 0) {
    const resp = await client.post(BULK_DELETE, toDelete)
    if (!resp.ok && resp.status !== 404) failures.push(`bulk-delete: ${iscErrorMessage(resp)}`)
  }

  if (failures.length) {
    return { success: false, message: `Some notification templates failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} notification template(s)`, rollbackData: { entries } }
}
