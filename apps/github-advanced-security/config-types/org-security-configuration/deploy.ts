import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage, parseJson, type GithubClient } from '../../lib/githubApi'
import {
  desiredFromItem,
  buildConfigBody,
  configBodyChanges,
  type CodeSecurityConfiguration,
  type OrgConfigDesired,
  type OrgConfigRollbackEntry,
} from './_shared'

/**
 * Deploy org-level GitHub code security configurations over the REST API:
 *   list:   GET   /orgs/{org}/code-security/configurations           (match by name / prior id)
 *   create: POST  /orgs/{org}/code-security/configurations
 *   update: PATCH /orgs/{org}/code-security/configurations/{id}       (only changed fields)
 *   attach: POST  /orgs/{org}/code-security/configurations/{id}/attach
 *
 * (org, name) is the stable identity. A configuration GitHub provides itself
 * (target_type "global") is read-only and skipped rather than failing. Each
 * item's prior id is loaded from the last successful deploy so a rename-in-place
 * still resolves the same object. rollbackData records, per configuration, the
 * prior full state (updates) or created id (creates) so rollback can restore or
 * delete it.
 */

/** Prior rollback entries from the last successful deploy, for id reconciliation. */
async function loadPriorEntries(ctx: DeployContext): Promise<OrgConfigRollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: OrgConfigRollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as OrgConfigRollbackEntry[]) : []
  } catch {
    return []
  }
}

/** List an org's configurations, returning ok=false with a reason on failure. */
async function listConfigurations(
  client: GithubClient,
  org: string,
): Promise<{ ok: true; configs: CodeSecurityConfiguration[] } | { ok: false; reason: string }> {
  const res = await client.listCodeSecurityConfigurations(org)
  if (!res.ok) return { ok: false, reason: `${res.status} ${githubErrorMessage(res)}` }
  const configs = parseJson<CodeSecurityConfiguration[]>(res.body)
  return { ok: true, configs: Array.isArray(configs) ? configs : [] }
}

/** Attach a configuration to repositories per the item's declared scope. */
async function attach(client: GithubClient, desired: OrgConfigDesired, id: number): Promise<void> {
  if (!desired.attachScope) return
  const body: Record<string, unknown> = { scope: desired.attachScope }
  if (desired.attachScope === 'selected') body.selected_repository_ids = desired.selectedRepositoryIds
  const res = await client.attachCodeSecurityConfiguration(desired.org, id, body)
  if (!res.ok) throw new Error(`attach: ${res.status} ${githubErrorMessage(res)}`)
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const prior = await loadPriorEntries(ctx)
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId!, p]))

  const entries: OrgConfigRollbackEntry[] = []
  const applied: string[] = []
  const skipped: string[] = []
  const failures: string[] = []

  // Cache each org's configuration list so N configs in one org list once.
  const listCache = new Map<string, CodeSecurityConfiguration[]>()

  for (const item of items) {
    const desired = desiredFromItem(item.fields)
    if (!desired.org || !desired.name) {
      skipped.push(`${desired.org || '(no org)'}/${desired.name || '(no name)'}`)
      continue
    }
    const fullName = `${desired.org}/${desired.name}`

    if (!listCache.has(desired.org)) {
      const listed = await listConfigurations(client, desired.org)
      if (!listed.ok) {
        skipped.push(`${fullName} (${listed.reason})`)
        continue
      }
      listCache.set(desired.org, listed.configs)
    }
    const configs = listCache.get(desired.org) ?? []

    const priorEntry = item.id ? priorByItem.get(item.id) : undefined
    const live =
      (priorEntry?.id != null ? configs.find((c) => c.id === priorEntry.id) : undefined) ??
      configs.find((c) => (c.name ?? '') === desired.name)

    try {
      if (live?.id != null) {
        if (live.target_type === 'global') {
          skipped.push(`${fullName} (GitHub-managed configuration is read-only)`)
          continue
        }
        entries.push({ itemId: item.id, org: desired.org, name: desired.name, existed: true, id: live.id, prior: live })
        const changes = configBodyChanges(desired, live)
        if (Object.keys(changes).length > 0) {
          const res = await client.updateCodeSecurityConfiguration(desired.org, live.id, changes)
          if (!res.ok) throw new Error(`update: ${res.status} ${githubErrorMessage(res)}`)
        }
        await attach(client, desired, live.id)
      } else {
        const res = await client.createCodeSecurityConfiguration(desired.org, buildConfigBody(desired))
        if (!res.ok) throw new Error(`create: ${res.status} ${githubErrorMessage(res)}`)
        const created = parseJson<CodeSecurityConfiguration>(res.body)
        const id = created?.id
        entries.push({ itemId: item.id, org: desired.org, name: desired.name, existed: false, id })
        if (id != null) {
          // Keep the org cache current so a later item in the same org sees it.
          configs.push({ ...created, id })
          await attach(client, desired, id)
        }
      }
      applied.push(fullName)
    } catch (error) {
      failures.push(`${fullName}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  const skipNote = skipped.length ? ` (skipped ${skipped.length}: ${skipped.join(', ')})` : ''
  if (failures.length > 0) {
    return {
      success: false,
      message: `Applied ${applied.length} configuration(s); ${failures.length} failed: ${failures.join(' | ')}${skipNote}`,
      artifacts: { applied, skipped, failures },
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Applied ${applied.length} org security configuration(s): ${applied.join(', ') || '(none)'}${skipNote}`,
    artifacts: { applied, skipped },
    rollbackData: { entries },
  }
}
