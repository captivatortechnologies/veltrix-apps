import deploy, { type StarRuleRollbackEntry } from '../deploy'
import {
  API_TOKEN,
  SCOPELESS_SETTINGS,
  apiError,
  callsTo,
  dataOf,
  deployContext,
  envelope,
  filterOf,
  withFetch,
  type CanvasItemInput,
  type RecordedCall,
} from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-star-rules'
const RULES = '/cloud-detection/rules'
const S1QL = 'EventType = "Process Creation" AND ProcessName Contains "powershell"'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return deployContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

function rule(fields: Record<string, unknown>): CanvasItemInput {
  return { name: `Rule ${String(fields.name ?? '')}`, fields }
}

const powershell = rule({ name: 'Suspicious PowerShell', s1ql: S1QL })

function previousState(result: { rollbackData?: unknown }): StarRuleRollbackEntry[] {
  return (result.rollbackData as { previousState?: StarRuleRollbackEntry[] } | undefined)?.previousState ?? []
}

function createdIds(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdIds?: string[] } | undefined)?.createdIds ?? []
}

function writes(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.method !== 'GET')
}

describe('SentinelOne STAR Rules Deploy Handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ configTypeId: CONFIG_TYPE, credential: null }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Scope ID setting is unset', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([powershell], SCOPELESS_SETTINGS))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Scope ID/)
      expect(calls).toHaveLength(0)
    })
  })

  it('authenticates every request with the API token and lists at the configured scope', async () => {
    await withFetch([envelope([])], async (calls) => {
      await deploy(ctx([]))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe(RULES)
      expect(calls[0].authorization).toBe(`ApiToken ${API_TOKEN}`)
      expect(calls[0].url).toContain('accountIds=act-1')
    })
  })

  it('creates a new rule as a Draft and then activates it', async () => {
    await withFetch([envelope([]), envelope({ id: 'rule-new' }), envelope({})], async (calls) => {
      const result = await deploy(ctx([powershell]))

      expect(result.success).toBe(true)
      const posts = callsTo(calls, RULES).filter((call) => call.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(filterOf(posts[0])).toEqual({ accountIds: ['act-1'] })
      expect(dataOf(posts[0])).toEqual({
        name: 'Suspicious PowerShell',
        description: '',
        s1ql: S1QL,
        queryType: 'events',
        severity: 'Medium',
        status: 'Draft',
        networkQuarantine: false,
        expirationMode: 'Permanent',
        queryLang: '2.0',
      })
      const enable = callsTo(calls, `${RULES}/enable`)
      expect(enable).toHaveLength(1)
      expect(enable[0].method).toBe('PUT')
      expect(filterOf(enable[0])).toEqual({ ids: ['rule-new'] })
      expect(createdIds(result)).toEqual(['rule-new'])
    })
  })

  it('leaves a newly created rule as a Draft when it is not meant to be active', async () => {
    await withFetch([envelope([]), envelope({ id: 'rule-new' })], async (calls) => {
      const result = await deploy(ctx([rule({ name: 'Draft rule', s1ql: S1QL, activate: false })]))

      expect(result.success).toBe(true)
      expect(callsTo(calls, `${RULES}/enable`)).toHaveLength(0)
      expect(callsTo(calls, `${RULES}/disable`)).toHaveLength(0)
    })
  })

  it('carries the expiration and threat verdict only when they apply', async () => {
    await withFetch([envelope([]), envelope({ id: 'rule-new' }), envelope({})], async (calls) => {
      await deploy(
        ctx([
          rule({
            name: 'Temporary hunt',
            s1ql: S1QL,
            expiration_mode: 'Temporary',
            expiration: '2026-12-31T00:00:00Z',
            treat_as_threat: 'Malicious',
            network_quarantine: true,
          }),
        ]),
      )

      const data = dataOf(callsTo(calls, RULES).filter((call) => call.method === 'POST')[0])
      expect(data.expiration).toBe('2026-12-31T00:00:00Z')
      expect(data.treatAsThreat).toBe('Malicious')
      expect(data.networkQuarantine).toBe(true)
    })
  })

  it('updates an existing rule by id, records its prior body, and reconciles activation', async () => {
    const live = {
      id: 'rule-1',
      name: 'Suspicious PowerShell',
      s1ql: 'old query',
      severity: 'Low',
      status: 'Active',
    }
    await withFetch([envelope([live]), envelope({}), envelope({})], async (calls) => {
      const result = await deploy(ctx([rule({ name: 'Suspicious PowerShell', s1ql: S1QL, activate: false })]))

      expect(result.success).toBe(true)
      const puts = callsTo(calls, `${RULES}/rule-1`)
      expect(puts).toHaveLength(1)
      expect(dataOf(puts[0]).s1ql).toBe(S1QL)
      // Desired state is Draft, so the rule is explicitly disabled after the write.
      expect(callsTo(calls, `${RULES}/disable`)).toHaveLength(1)
      expect(previousState(result)[0].prior).toEqual(live)
      expect(createdIds(result)).toEqual([])
    })
  })

  it('matches an existing rule whose name differs only by case', async () => {
    const live = { id: 'rule-1', name: 'suspicious POWERSHELL', status: 'Active' }
    await withFetch([envelope([live]), envelope({}), envelope({})], async (calls) => {
      await deploy(ctx([powershell]))

      expect(callsTo(calls, `${RULES}/rule-1`)).toHaveLength(1)
      expect(callsTo(calls, RULES).filter((call) => call.method === 'POST')).toHaveLength(0)
    })
  })

  it('reports failure rather than throwing when the vendor rejects a create', async () => {
    await withFetch([envelope([]), apiError('S1QL syntax error', 400)], async () => {
      const result = await deploy(ctx([powershell]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/S1QL syntax error/)
      expect(createdIds(result)).toEqual([])
    })
  })

  it('reports failure when a create returns no id rather than recording a phantom rule', async () => {
    await withFetch([envelope([]), envelope({})], async () => {
      const result = await deploy(ctx([powershell]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/returned no id/)
      expect(previousState(result)).toEqual([])
    })
  })

  it('still records the created rule when only the activation call fails', async () => {
    await withFetch(
      [envelope([]), envelope({ id: 'rule-new' }), apiError('rule cannot be enabled', 400)],
      async () => {
        const result = await deploy(ctx([powershell]))

        expect(result.success).toBe(false)
        expect(result.message).toMatch(/rule cannot be enabled/)
        // Without this, rollback would leave an orphaned Draft rule behind.
        expect(createdIds(result)).toEqual(['rule-new'])
        expect(previousState(result)[0].existed).toBe(false)
      },
    )
  })

  it('reports failure when the scoped list itself is rejected', async () => {
    await withFetch([apiError('token lacks scope', 401)], async (calls) => {
      const result = await deploy(ctx([powershell]))

      expect(result.success).toBe(false)
      expect(writes(calls)).toHaveLength(0)
    })
  })
})
