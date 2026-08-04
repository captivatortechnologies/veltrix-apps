import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage, parseJson, type GithubClient } from '../../lib/githubApi'
import { desiredFromItem, parseRepository, buildAutolinkBody, matchesLive, type LiveAutolink, type AutolinkRollbackEntry } from './_shared'

/**
 * Deploy repository autolinks over the REST API:
 *   list:   GET    /repos/{owner}/{repo}/autolinks         (match by prior/desired key_prefix)
 *   create: POST   /repos/{owner}/{repo}/autolinks
 *   delete: DELETE /repos/{owner}/{repo}/autolinks/{id}     (used for both a changed value and reconcile)
 *
 * There is no update endpoint, so a value change is a delete + create — the
 * autolink's id is expected to churn when its shape changes. (repository,
 * key_prefix) is the stable identity for humans; internally each item's prior
 * key_prefix is loaded from the last successful deploy so a renamed key_prefix
 * still resolves the same declared item. rollbackData records, per item,
 * whether an autolink existed before this deploy (and its prior shape) so
 * rollback can recreate it or delete what was created; autolinks this app
 * created previously but no longer declares are reconciled away.
 */

async function loadPriorEntries(ctx: DeployContext): Promise<AutolinkRollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: AutolinkRollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as AutolinkRollbackEntry[]) : []
  } catch {
    return []
  }
}

async function listAutolinks(
  client: GithubClient,
  owner: string,
  repo: string,
): Promise<{ ok: true; autolinks: LiveAutolink[] } | { ok: false; reason: string }> {
  const res = await client.listAutolinks(owner, repo)
  if (!res.ok) return { ok: false, reason: `${res.status} ${githubErrorMessage(res)}` }
  const autolinks = parseJson<LiveAutolink[]>(res.body)
  return { ok: true, autolinks: Array.isArray(autolinks) ? autolinks : [] }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const prior = await loadPriorEntries(ctx)
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId!, p]))

  const entries: AutolinkRollbackEntry[] = []
  const applied: string[] = []
  const skipped: string[] = []
  const failures: string[] = []
  const listCache = new Map<string, LiveAutolink[]>()

  for (const item of items) {
    const desired = desiredFromItem(item.fields)
    const parsed = parseRepository(desired.repository)
    const fullName = `${desired.repository || '(blank)'} · ${desired.keyPrefix || '(no prefix)'}`
    if (!parsed || !desired.keyPrefix || !desired.urlTemplate) {
      skipped.push(fullName)
      continue
    }
    const { owner, repo } = parsed
    const repoKey = `${owner}/${repo}`

    if (!listCache.has(repoKey)) {
      const listed = await listAutolinks(client, owner, repo)
      if (!listed.ok) {
        skipped.push(`${fullName} (${listed.reason})`)
        continue
      }
      listCache.set(repoKey, listed.autolinks)
    }
    const autolinks = listCache.get(repoKey) ?? []

    const priorEntry = item.id ? priorByItem.get(item.id) : undefined
    const lookupKeyPrefix = priorEntry?.prior?.key_prefix ?? desired.keyPrefix
    const live = autolinks.find((a) => (a.key_prefix ?? '') === lookupKeyPrefix)

    try {
      if (live?.id != null && matchesLive(desired, live)) {
        // Already in the desired shape — nothing to do.
        entries.push({ itemId: item.id, repository: repoKey, existed: true, id: live.id, prior: live })
      } else if (live?.id != null) {
        // Changed shape or renamed key_prefix — delete the old one, create the new one.
        const del = await client.deleteAutolink(owner, repo, live.id)
        if (!del.ok && del.status !== 404) throw new Error(`delete: ${del.status} ${githubErrorMessage(del)}`)
        const created = await client.createAutolink(owner, repo, buildAutolinkBody(desired))
        if (!created.ok) throw new Error(`create: ${created.status} ${githubErrorMessage(created)}`)
        const newLink = parseJson<LiveAutolink>(created.body)
        entries.push({ itemId: item.id, repository: repoKey, existed: true, id: newLink?.id, prior: live })
        if (newLink?.id != null) {
          const idx = autolinks.indexOf(live)
          if (idx >= 0) autolinks.splice(idx, 1, newLink)
        }
      } else {
        const created = await client.createAutolink(owner, repo, buildAutolinkBody(desired))
        if (!created.ok) throw new Error(`create: ${created.status} ${githubErrorMessage(created)}`)
        const newLink = parseJson<LiveAutolink>(created.body)
        entries.push({ itemId: item.id, repository: repoKey, existed: false, id: newLink?.id })
        if (newLink) autolinks.push(newLink)
      }
      applied.push(fullName)
    } catch (error) {
      failures.push(`${fullName}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  // Reconcile: delete autolinks THIS app created previously but no longer declares.
  const declaredItems = new Set(items.map((it) => it.id).filter(Boolean))
  for (const p of prior) {
    if (p.existed || p.id == null) continue
    if (p.itemId && declaredItems.has(p.itemId)) continue
    const parts = p.repository.split('/')
    if (parts.length !== 2) continue
    const del = await client.deleteAutolink(parts[0], parts[1], p.id)
    if (!del.ok && del.status !== 404) {
      failures.push(`delete ${p.repository} · autolink ${p.id}: ${del.status} ${githubErrorMessage(del)}`)
    }
  }

  const skipNote = skipped.length ? ` (skipped ${skipped.length}: ${skipped.join(', ')})` : ''
  if (failures.length > 0) {
    return {
      success: false,
      message: `Applied ${applied.length} autolink(s); ${failures.length} failed: ${failures.join(' | ')}${skipNote}`,
      artifacts: { applied, skipped, failures },
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Applied ${applied.length} autolink(s): ${applied.join(', ') || '(none)'}${skipNote}`,
    artifacts: { applied, skipped },
    rollbackData: { entries },
  }
}
