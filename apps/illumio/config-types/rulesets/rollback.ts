import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  readIllumioSettings,
  resolveIllumioCredential,
  buildIllumioBaseUrl,
  basicAuthHeader,
  sendJson,
  provisionChanges,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/illumioApi'
import type { RuleSetRollbackEntry } from './_shared'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Roll back a rulesets deploy, then re-provision the undo so it takes effect.
 *
 * KNOWN LIMITATION (flagged, not faked): this restores ruleset-level metadata
 * (scopes/enabled/description, when the ruleset pre-existed) and reverses rule
 * CREATES this app made (by deleting them). It does NOT restore rules a deploy
 * DELETED — their prior bodies aren't captured, only the set this app
 * currently manages. Full per-rule restore (capturing every removed rule's
 * body) is a follow-up; for now, re-deploying the desired canvas state is the
 * reliable way to recover from a rule removal you want undone.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readIllumioSettings(ctx.settings)
  const base = buildIllumioBaseUrl(settings)
  if (!base) return { success: false, message: 'No PCE host is configured — set the "PCE host" app setting.' }
  const cred = resolveIllumioCredential(ctx.credential)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const headers = basicAuthHeader(cred)
  const opts = { timeoutMs: settings.timeoutMs, verifyTls: settings.verifyTls }

  const data = ctx.rollbackData as { entries?: RuleSetRollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  const changedHrefs = new Set<string>()
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (!e.href) continue

    if (e.existed) {
      if (e.prior) {
        try {
          await sendJson('PUT', `${base}${e.href}`, headers, e.prior, opts)
          restored++
          changedHrefs.add(e.href)
        } catch (err) {
          failures.push(`restore ${e.name}: ${errorMessage(err)}`)
        }
      }
      // Undo rules this app added/manages under this pre-existing ruleset.
      for (const r of e.rules ?? []) {
        try {
          await sendJson('DELETE', `${base}${r.href}`, headers, undefined, opts)
          changedHrefs.add(e.href)
        } catch (err) {
          failures.push(`delete rule under ${e.name}: ${errorMessage(err)}`)
        }
      }
    } else {
      // This app created the whole ruleset — deleting it removes its rules too.
      try {
        await sendJson('DELETE', `${base}${e.href}`, headers, undefined, opts)
        deleted++
        changedHrefs.add(e.href)
      } catch (err) {
        failures.push(`delete ${e.name}: ${errorMessage(err)}`)
      }
    }
  }

  let provisionNote = ''
  if (changedHrefs.size > 0) {
    try {
      await provisionChanges(base, settings, headers, `Veltrix: rollback rulesets (${changedHrefs.size} change(s))`, {
        rule_sets: [...changedHrefs].map((href) => ({ href })),
      })
      provisionNote = `; provisioned ${changedHrefs.size} change(s)`
    } catch (err) {
      failures.push(`provision failed: ${errorMessage(err)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back rulesets: ${deleted} deleted, ${restored} restored${provisionNote}` }
}
