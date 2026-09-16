import deploy, { type RollbackEntry } from '../deploy'
import {
  AUTH_TOKEN,
  NO_BASE_URL_SETTINGS,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  arrayBody,
  callsTo,
  cbError,
  cbJson,
  deployContext,
  mentionsSecret,
  withFetch,
  writes,
  type ItemInput,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'policy-rule-configs'
const POLICIES = `/policyservice/v1/orgs/${ORG_KEY}/policies`
const SUMMARY = `${POLICIES}/summary`
const RULE_CONFIGS = `${POLICIES}/7/rule_configs`
const CORE = `${RULE_CONFIGS}/core_prevention`

const POLICY_LIST = { policies: [{ id: 7, name: 'Standard', priority_level: 'HIGH' }] }

/** Two core-prevention configs — one with exclusions, one without — plus a category this app must not touch. */
const CORE_A = {
  id: 'rc-a',
  category: 'core_prevention',
  parameters: { WindowsAssignmentMode: 'BLOCK' },
  exclusions: { windows: [{ criteria: ['tools'] }] },
}
const CORE_B = { id: 'rc-b', category: 'core_prevention', parameters: { WindowsAssignmentMode: 'BLOCK' } }
const BYPASS = { id: 'rc-z', category: 'bypass', parameters: { WindowsAssignmentMode: 'BLOCK' } }
const LIVE_CONFIGS = { results: [CORE_A, CORE_B, BYPASS] }

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return deployContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function ruleConfig(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.policyName ?? ''), fields }
}

const REPORT_MODE = ruleConfig({ policyName: 'Standard', assignmentMode: 'REPORT' })

function entries(result: { rollbackData?: unknown }): RollbackEntry[] {
  return ((result.rollbackData as { entries?: RollbackEntry[] } | undefined)?.entries ?? [])
}

describe('carbon-black policy-rule-configs deploy handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([REPORT_MODE], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Org Key setting is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([REPORT_MODE], { settings: NO_ORG_KEY_SETTINGS }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Org Key/)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the region base URL is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([REPORT_MODE], { settings: NO_BASE_URL_SETTINGS }))

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('authenticates every request with the API key and never echoes the secret', async () => {
    await withFetch([cbJson(POLICY_LIST), cbJson(LIVE_CONFIGS), cbJson({})], async (calls) => {
      const result = await deploy(ctx([REPORT_MODE]))

      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) expect(call.authToken).toBe(AUTH_TOKEN)
      expect(calls[0].path).toBe(SUMMARY)
      expect(mentionsSecret(result.message)).toBe(false)
    })
  })

  it('resolves the policy by name, then PUTs the mode onto every core-prevention config', async () => {
    await withFetch([cbJson(POLICY_LIST), cbJson(LIVE_CONFIGS), cbJson({})], async (calls) => {
      const result = await deploy(ctx([REPORT_MODE]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(3)
      expect(calls[0].path).toBe(SUMMARY)
      expect(calls[1].method).toBe('GET')
      expect(calls[1].path).toBe(RULE_CONFIGS)

      const put = writes(calls)
      expect(put).toHaveLength(1)
      expect(put[0].method).toBe('PUT')
      expect(put[0].path).toBe(CORE)
      // The bypass config is absent: PUTting a foreign category's config into
      // core_prevention would rewrite settings this app does not manage.
      expect(arrayBody(put[0])).toEqual([
        { id: 'rc-a', parameters: { WindowsAssignmentMode: 'REPORT' }, exclusions: { windows: [{ criteria: ['tools'] }] } },
        { id: 'rc-b', parameters: { WindowsAssignmentMode: 'REPORT' } },
      ])
    })
  })

  it('records the live modes and exclusions as the rollback snapshot, not the desired ones', async () => {
    await withFetch([cbJson(POLICY_LIST), cbJson(LIVE_CONFIGS), cbJson({})], async () => {
      const result = await deploy(ctx([REPORT_MODE]))

      expect(result.success).toBe(true)
      // `existed: true` throughout — a rule-config category is platform-managed
      // and always pre-exists, so rollback resets it and never deletes a policy.
      expect(entries(result)).toEqual([
        {
          itemId: 'item-1',
          policyName: 'Standard',
          policyId: '7',
          existed: true,
          prior: {
            configs: [
              { id: 'rc-a', WindowsAssignmentMode: 'BLOCK', exclusions: { windows: [{ criteria: ['tools'] }] } },
              { id: 'rc-b', WindowsAssignmentMode: 'BLOCK', exclusions: undefined },
            ],
          },
        },
      ])
    })
  })

  it('applies a supplied exclusions object to every core-prevention config', async () => {
    await withFetch([cbJson(POLICY_LIST), cbJson(LIVE_CONFIGS), cbJson({})], async (calls) => {
      const result = await deploy(
        ctx([
          ruleConfig({
            policyName: 'Standard',
            assignmentMode: 'BLOCK',
            exclusionsJson: '{"windows":[{"criteria":["override"]}]}',
          }),
        ]),
      )

      expect(result.success).toBe(true)
      expect(arrayBody(writes(calls)[0])).toEqual([
        { id: 'rc-a', parameters: { WindowsAssignmentMode: 'BLOCK' }, exclusions: { windows: [{ criteria: ['override'] }] } },
        { id: 'rc-b', parameters: { WindowsAssignmentMode: 'BLOCK' }, exclusions: { windows: [{ criteria: ['override'] }] } },
      ])
    })
  })

  it('reads a bare-array rule-config response as well as the results-wrapped one', async () => {
    await withFetch([cbJson(POLICY_LIST), cbJson([CORE_A]), cbJson({})], async (calls) => {
      const result = await deploy(ctx([REPORT_MODE]))

      expect(result.success).toBe(true)
      expect(arrayBody(writes(calls)[0])).toHaveLength(1)
    })
  })

  it('fails loudly when the policy name cannot be resolved, and writes nothing', async () => {
    await withFetch([cbJson({ policies: [{ id: 9, name: 'Something Else' }] })], async (calls) => {
      const result = await deploy(ctx([REPORT_MODE]))

      // Silently skipping would report a green deploy for protections never applied.
      expect(result.success).toBe(false)
      expect(result.message).toContain('Standard: policy not found')
      expect(calls).toHaveLength(1)
      expect(writes(calls)).toHaveLength(0)
      expect(entries(result)).toEqual([])
    })
  })

  it('stops at the policy listing failure rather than writing against an unknown live state', async () => {
    await withFetch([cbError('forbidden', 403)], async (calls) => {
      const result = await deploy(ctx([REPORT_MODE]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to list policies/)
      expect(result.message).toContain('forbidden')
      expect(calls).toHaveLength(1)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('does not write when the policy rule configs cannot be read', async () => {
    await withFetch([cbJson(POLICY_LIST), cbError('rule configs unavailable', 500)], async (calls) => {
      const result = await deploy(ctx([REPORT_MODE]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('rule configs unavailable')
      expect(writes(calls)).toHaveLength(0)
      expect(entries(result)).toEqual([])
    })
  })

  it('fails a policy carrying no core-prevention configs instead of skipping it', async () => {
    await withFetch([cbJson(POLICY_LIST), cbJson({ results: [BYPASS] })], async (calls) => {
      const result = await deploy(ctx([REPORT_MODE]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('no core_prevention rule configs on this policy')
      expect(writes(calls)).toHaveLength(0)
      expect(entries(result)).toEqual([])
    })
  })

  it('reports failure rather than throwing when the vendor rejects the rule-config PUT', async () => {
    await withFetch([cbJson(POLICY_LIST), cbJson(LIVE_CONFIGS), cbError('assignment mode not permitted', 400)], async () => {
      const result = await deploy(ctx([REPORT_MODE]))

      // A handler that throws surfaces as an opaque pipeline crash; the contract
      // is a DeployResult carrying the reason.
      expect(result.success).toBe(false)
      expect(result.message).toContain('assignment mode not permitted')
      expect(mentionsSecret(result.message)).toBe(false)
      expect(entries(result)).toEqual([])
    })
  })

  it('resets the category of a policy it no longer declares, and never deletes the policy', async () => {
    const prior: RollbackEntry[] = [
      { itemId: 'item-9', policyName: 'Retired', policyId: '55', existed: true, prior: { configs: [] } },
    ]
    await withFetch([cbJson({ policies: [] }), cbJson({})], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      const deletes = writes(calls)
      expect(deletes).toHaveLength(1)
      expect(deletes[0].method).toBe('DELETE')
      expect(deletes[0].path).toBe(`${POLICIES}/55/rule_configs/core_prevention`)
      // The reconcile deletes the rule-config category only — a DELETE on the
      // bare policy path would destroy the policy and orphan its devices.
      expect(callsTo(calls, `${POLICIES}/55`)).toHaveLength(0)
    })
  })

  it('does not reset the category of a policy it still declares', async () => {
    const prior: RollbackEntry[] = [
      { itemId: 'item-1', policyName: 'Standard', policyId: '7', existed: true, prior: { configs: [] } },
    ]
    await withFetch([cbJson(POLICY_LIST), cbJson(LIVE_CONFIGS), cbJson({})], async (calls) => {
      const result = await deploy(ctx([REPORT_MODE], { priorEntries: prior }))

      expect(result.success).toBe(true)
      const written = writes(calls)
      expect(written).toHaveLength(1)
      expect(written[0].method).toBe('PUT')
    })
  })

  it('does not reset a category just because this run could not resolve its policy', async () => {
    const prior: RollbackEntry[] = [
      { itemId: 'item-1', policyName: 'Standard', policyId: '7', existed: true, prior: { configs: [] } },
    ]
    await withFetch([cbJson({ policies: [] })], async (calls) => {
      const result = await deploy(ctx([REPORT_MODE], { priorEntries: prior }))

      // A transient lookup failure must not tear live prevention back to default.
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(1)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('deploys anyway when the platform cannot supply the previous deployment', async () => {
    await withFetch([cbJson(POLICY_LIST), cbJson(LIVE_CONFIGS), cbJson({})], async () => {
      const result = await deploy(ctx([REPORT_MODE], { platformThrows: true }))

      expect(result.success).toBe(true)
      expect(entries(result)).toHaveLength(1)
    })
  })

  it('keeps the API secret in the auth header — never in a URL, a body or a message', async () => {
    await withFetch([cbJson(POLICY_LIST), cbJson(LIVE_CONFIGS), cbError('unauthorized', 401)], async (calls) => {
      const result = await deploy(ctx([REPORT_MODE]))

      expect(result.success).toBe(false)
      expect(mentionsSecret(result.message)).toBe(false)
      for (const call of calls) {
        expect(mentionsSecret(call.url)).toBe(false)
        expect(mentionsSecret(call.body)).toBe(false)
      }
    })
  })
})
