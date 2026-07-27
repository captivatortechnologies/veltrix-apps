import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  parseJson,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
  type SecOpsClient,
} from '../../lib/googlesecops'
import { extractRuleSpecs, normalizeRuleText, type LiveRule } from './validate'

export interface RollbackEntry {
  itemId?: string
  ruleName: string
  /** Whether the rule existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  /** The server-assigned ruleId, kept so rollback/reconcile can target it even after a rename. */
  ruleName_live?: string
  priorText?: string
}

const enc = encodeURIComponent

/** The server-assigned ruleId at the tail of a `{parent}/rules/{ruleId}` name. */
export function ruleIdOf(name: string): string {
  return name.split('/').pop() ?? ''
}

/** List every rule under the parent, following pagination. */
export async function listRules(client: SecOpsClient, parent: string): Promise<{ ok: boolean; rules: LiveRule[]; error?: string }> {
  const rules: LiveRule[] = []
  let pageToken = ''
  do {
    const query = pageToken ? `?pageSize=1000&pageToken=${enc(pageToken)}` : '?pageSize=1000'
    const res = await client.request('GET', `${parent}/rules${query}`)
    if (!res.ok) return { ok: false, rules, error: secopsErrorMessage(res) }
    const parsed = parseJson<{ rules?: LiveRule[]; nextPageToken?: string }>(res.body)
    if (parsed?.rules) rules.push(...parsed.rules)
    pageToken = parsed?.nextPageToken ?? ''
  } while (pageToken)
  return { ok: true, rules }
}

/**
 * Best-effort pre-check via `rules:verifyRuleText`. Returns blocked=true only
 * when Chronicle affirmatively reports the text does not compile; a transport
 * error leaves the rule to be validated by the create/update call itself.
 */
async function verifyRuleText(client: SecOpsClient, parent: string, text: string): Promise<{ blocked: boolean; message?: string }> {
  const res = await client.request('POST', `${parent}/rules:verifyRuleText`, { ruleText: text })
  if (!res.ok) return { blocked: false }
  const parsed = parseJson<{ success?: boolean; compilationDiagnostics?: Array<{ message?: string }> }>(res.body)
  if (parsed?.success === false) {
    const diagnostics = (parsed.compilationDiagnostics ?? []).map((d) => d.message).filter(Boolean).join('; ')
    return { blocked: true, message: diagnostics || 'rule text failed compilation' }
  }
  return { blocked: false }
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
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const specs = extractRuleSpecs(ctx.canvas).filter((s) => s.ruleName)
  const prior = await loadPriorEntries(ctx)

  // A rule's identity is server-assigned, so resolve it by listing: match a spec
  // to its live rule by the ruleId we stored last deploy (rename-safe), else by
  // the current displayName.
  const listed = await listRules(client, parent)
  if (!listed.ok) return { success: false, message: `Could not list Google SecOps rules: ${listed.error}` }
  const byRuleId = new Map(listed.rules.map((r) => [ruleIdOf(r.name ?? ''), r]))
  const byDisplayName = new Map(listed.rules.map((r) => [r.displayName ?? '', r]))
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId!, p]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const verified = await verifyRuleText(client, parent, spec.text)
    if (verified.blocked) {
      failures.push(`${spec.ruleName}: ${verified.message}`)
      continue
    }

    const priorEntry = spec.itemId ? priorByItem.get(spec.itemId) : undefined
    const live = (priorEntry?.ruleName_live ? byRuleId.get(priorEntry.ruleName_live) : undefined) ?? byDisplayName.get(spec.ruleName)

    if (live) {
      const ruleId = ruleIdOf(live.name ?? '')
      const priorText = live.text ?? ''
      if (normalizeRuleText(priorText) !== normalizeRuleText(spec.text)) {
        const resp = await client.request('PATCH', `${parent}/rules/${enc(ruleId)}?updateMask=text`, { text: spec.text })
        if (!resp.ok) {
          failures.push(`${spec.ruleName}: ${secopsErrorMessage(resp)}`)
          continue
        }
      }
      entries.push({ itemId: spec.itemId, ruleName: spec.ruleName, existed: true, ruleName_live: ruleId, priorText })
    } else {
      const resp = await client.request('POST', `${parent}/rules`, { text: spec.text })
      if (!resp.ok) {
        failures.push(`${spec.ruleName}: ${secopsErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveRule>(resp.body)
      entries.push({ itemId: spec.itemId, ruleName: spec.ruleName, existed: false, ruleName_live: ruleIdOf(created?.name ?? '') })
    }
  }

  // Reconcile: delete rules THIS app created previously but no longer declares.
  // Guard by itemId as well as name so a renamed (still-declared) rule — updated
  // above under the same item — is not deleted out from under itself.
  const declaredNames = new Set(specs.map((s) => s.ruleName.toLowerCase()))
  const declaredItems = new Set(specs.map((s) => s.itemId).filter(Boolean))
  for (const p of prior) {
    if (p.existed || !p.ruleName_live) continue
    if ((p.itemId && declaredItems.has(p.itemId)) || declaredNames.has(p.ruleName.toLowerCase())) continue
    const del = await client.request('DELETE', `${parent}/rules/${enc(p.ruleName_live)}?force=true`)
    if (!del.ok && del.status !== 404) failures.push(`delete ${p.ruleName}: ${secopsErrorMessage(del)}`)
  }

  if (failures.length) {
    return { success: false, message: `Some detection rules failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} detection rule(s)`, rollbackData: { entries } }
}
