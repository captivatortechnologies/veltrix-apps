import driftDetect from '../driftDetect'
import {
  AUTH_TOKEN,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  cbJson,
  driftContext,
  withFetch,
  type ItemInput,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'policy-rule-configs'
const POLICIES = `/policyservice/v1/orgs/${ORG_KEY}/policies`
const SUMMARY = `${POLICIES}/summary`
const RULE_CONFIGS = `${POLICIES}/7/rule_configs`

const POLICY_LIST = { policies: [{ id: 7, name: 'Standard', priority_level: 'HIGH' }] }

const CORE_A = { id: 'rc-a', category: 'core_prevention', parameters: { WindowsAssignmentMode: 'REPORT' } }
const CORE_B = { id: 'rc-b', category: 'core_prevention', parameters: { WindowsAssignmentMode: 'REPORT' } }
const BYPASS = { id: 'rc-z', category: 'bypass', parameters: { WindowsAssignmentMode: 'BLOCK' } }

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function ruleConfig(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.policyName ?? ''), fields }
}

const DEPLOYED = ruleConfig({ policyName: 'Standard', assignmentMode: 'REPORT' })

describe('carbon-black policy-rule-configs driftDetect handler', () => {
  it('reports no drift without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift when the Org Key setting is blank', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { settings: NO_ORG_KEY_SETTINGS }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('calls nothing when the canvas declares no rule configs', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([]))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('finds no drift when every core-prevention config still runs in the deployed mode', async () => {
    await withFetch([cbJson(POLICY_LIST), cbJson({ results: [CORE_A, CORE_B, BYPASS] })], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(2)
      expect(calls[0].path).toBe(SUMMARY)
      expect(calls[1].path).toBe(RULE_CONFIGS)
      for (const call of calls) expect(call.authToken).toBe(AUTH_TOKEN)
    })
  })

  it('flags a policy that no longer exists as critical, without reading its rule configs', async () => {
    await withFetch([cbJson({ policies: [] })], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('Standard')
      expect(result.diffs[0].expected).toBe('present')
      expect(result.diffs[0].actual).toBe('absent')
      expect(result.diffs[0].severity).toBe('critical')
      expect(calls).toHaveLength(1)
    })
  })

  it('flags a policy whose core-prevention category has gone as critical', async () => {
    await withFetch([cbJson(POLICY_LIST), cbJson({ results: [BYPASS] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('Standard.core_prevention')
      expect(result.diffs[0].actual).toBe('absent')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('flags prevention dropped from BLOCK to REPORT out of band', async () => {
    const live = { results: [{ ...CORE_A, parameters: { WindowsAssignmentMode: 'REPORT' } }] }
    await withFetch([cbJson(POLICY_LIST), cbJson(live)], async () => {
      const result = await driftDetect(ctx([ruleConfig({ policyName: 'Standard', assignmentMode: 'BLOCK' })]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Standard.WindowsAssignmentMode')!
      expect(diff.expected).toBe('BLOCK')
      expect(diff.actual).toBe('REPORT')
      expect(diff.severity).toBe('warning')
    })
  })

  it('flags the category when only one of its configs was changed', async () => {
    const live = { results: [{ ...CORE_A, parameters: { WindowsAssignmentMode: 'BLOCK' } }, CORE_B] }
    await withFetch([cbJson(POLICY_LIST), cbJson(live)], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('Standard.WindowsAssignmentMode')
      expect(result.diffs[0].actual).toBe('BLOCK')
    })
  })

  it('flags a config carrying no assignment mode at all', async () => {
    await withFetch([cbJson(POLICY_LIST), cbJson({ results: [{ id: 'rc-a', category: 'core_prevention' }] })], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('Standard.WindowsAssignmentMode')
      expect(result.diffs[0].actual).toBe('')
    })
  })

  it('reports no drift when the policy listing fails, rather than inventing absences', async () => {
    await withFetch([cbError('service unavailable', 503)], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      // A handler that cannot read live state must not claim everything is gone.
      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(1)
    })
  })

  it('reports no drift when the rule-config read fails, rather than inventing absences', async () => {
    await withFetch([cbJson(POLICY_LIST), cbError('rule configs unavailable', 500)], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(2)
    })
  })
})
