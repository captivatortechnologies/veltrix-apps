import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildInsightIDRClient,
  insightIDRErrorMessage,
  parseJson,
  type InsightIDRClient,
} from '../../lib/insightidr'
import { indexRulesByName, listDetectionRules, resolveRuleByName } from '../../lib/insightidr-rules'
import {
  exceptionKey,
  exceptionLabel,
  extractExceptionSpecs,
  parseConditions,
  type ExceptionSpec,
  type LiveRuleException,
} from './validate'

export interface ExceptionRollbackEntry {
  key: string
  label: string
  /** true when the exception already existed live (skipped); false when we created it. */
  existed: boolean
  ruleRrn: string
  exceptionRrn?: string
}

/**
 * Deploy Rapid7 InsightIDR detection rule exceptions via the Insight Platform
 * Detection Rules API.
 *
 * Identity is the (parent rule name, exception name) natural key. The parent rule
 * name is resolved to its RRN via GET /idr/v1/rules; the exception is then matched
 * against the rule's existing exceptions by name. This config type is CREATE/skip
 * only: an exception is POSTed when absent and left untouched when already present
 * (the rule-exception update API is a field-diff format not modeled here). Only
 * created exceptions are recorded for rollback.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildInsightIDRClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractExceptionSpecs(ctx.canvas).filter((s) => s.ruleName && s.name && s.type)
  const rollbackState: ExceptionRollbackEntry[] = []
  const created: string[] = []
  const skipped: string[] = []

  try {
    const rulesByName = indexRulesByName(await listDetectionRules(client))
    const exceptionsByRule = new Map<string, Map<string, LiveRuleException>>()

    for (const spec of specs) {
      const label = exceptionLabel(spec)
      const resolved = resolveRuleByName(rulesByName, spec.ruleName)
      if ('error' in resolved) throw new Error(`Cannot create exception "${spec.name}": ${resolved.error}`)
      const ruleRrn = resolved.rule.rrn as string

      let existing = exceptionsByRule.get(ruleRrn)
      if (!existing) {
        existing = new Map<string, LiveRuleException>()
        for (const live of await listExceptionsForRule(client, ruleRrn)) {
          const name = (live.name ?? '').trim().toLowerCase()
          if (name && !existing.has(name)) existing.set(name, live)
        }
        exceptionsByRule.set(ruleRrn, existing)
      }

      const key = exceptionKey(spec)
      const live = existing.get(spec.name.trim().toLowerCase())
      if (live) {
        rollbackState.push({ key, label, existed: true, ruleRrn, exceptionRrn: live.rrn })
        skipped.push(label)
        continue
      }

      const res = await client.request('POST', `/idr/v1/rules/${encodeURIComponent(ruleRrn)}/rule-exceptions/create`, {
        body: buildBody(spec),
      })
      if (!res.ok) throw new Error(`Failed to create exception "${label}": ${insightIDRErrorMessage(res)}`)
      const createdBody = parseJson<{ rrn?: string }>(res.body)
      rollbackState.push({ key, label, existed: false, ruleRrn, exceptionRrn: createdBody?.rrn })
      created.push(label)
      existing.set(spec.name.trim().toLowerCase(), { rrn: createdBody?.rrn, name: spec.name })
    }

    const summary = `Created ${created.length}, skipped ${skipped.length} existing detection rule exception(s) on ${baseUrl}`
    return {
      success: true,
      message: created.length ? `${summary}: ${created.join(', ')}` : summary,
      artifacts: { baseUrl, createdExceptions: created, skippedExceptions: skipped },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Detection rule exception deployment failed after ${created.length + skipped.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, createdExceptions: created, skippedExceptions: skipped },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** List the exceptions attached to one detection rule; throws on a non-OK response. */
export async function listExceptionsForRule(client: InsightIDRClient, ruleRrn: string): Promise<LiveRuleException[]> {
  const res = await client.request('GET', `/idr/v1/rules/${encodeURIComponent(ruleRrn)}/rule-exceptions`)
  if (!res.ok) {
    throw new Error(`Failed to list exceptions for rule: ${insightIDRErrorMessage(res)}`)
  }
  const parsed = parseJson<LiveRuleException[]>(res.body)
  return Array.isArray(parsed) ? parsed : []
}

function buildBody(spec: ExceptionSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    type: spec.type,
    rule_action: spec.ruleAction,
  }
  if (spec.priorityLevel) body.priority_level = spec.priorityLevel
  if (spec.serviceLevel) body.service_level = spec.serviceLevel
  if (spec.note) body.note = spec.note

  if (spec.type === 'LEQL') {
    body.value = spec.leql.trim()
  } else {
    body.value = parseConditions(spec.keyValueJson).value ?? []
  }
  return body
}
