import deploy, { type FirewallRuleRollbackEntry } from '../deploy'
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

const CONFIG_TYPE = 's1-firewall-rules'
const FIREWALL = '/firewall-control'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return deployContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

function fwRule(fields: Record<string, unknown>): CanvasItemInput {
  return { name: `Rule ${String(fields.name ?? '')}`, fields }
}

const blockRdp = fwRule({
  name: 'Block inbound RDP',
  action: 'Blocked',
  direction: 'inbound',
  os_type: 'windows',
  service: '3389',
})

function previousState(result: { rollbackData?: unknown }): FirewallRuleRollbackEntry[] {
  return (
    (result.rollbackData as { previousState?: FirewallRuleRollbackEntry[] } | undefined)?.previousState ?? []
  )
}

function createdIds(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdIds?: string[] } | undefined)?.createdIds ?? []
}

function writes(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.method !== 'GET')
}

describe('SentinelOne Firewall Rules Deploy Handler', () => {
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
      const result = await deploy(ctx([blockRdp], SCOPELESS_SETTINGS))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Scope ID/)
      expect(calls).toHaveLength(0)
    })
  })

  it('authenticates every request with the API token and lists at the configured scope', async () => {
    await withFetch([envelope([])], async (calls) => {
      await deploy(ctx([]))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe(FIREWALL)
      expect(calls[0].authorization).toBe(`ApiToken ${API_TOKEN}`)
      expect(calls[0].url).toContain('accountIds=act-1')
    })
  })

  it('creates a rule that does not exist yet, scoped by filter', async () => {
    await withFetch([envelope([]), envelope({ id: 'fw-new' })], async (calls) => {
      const result = await deploy(ctx([blockRdp]))

      expect(result.success).toBe(true)
      const posts = callsTo(calls, FIREWALL).filter((call) => call.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(filterOf(posts[0])).toEqual({ accountIds: ['act-1'] })
      expect(dataOf(posts[0])).toEqual({
        name: 'Block inbound RDP',
        description: '',
        action: 'Blocked',
        direction: 'inbound',
        osType: 'windows',
        protocol: '',
        application: '',
        service: '3389',
        status: 'Enabled',
      })
      expect(createdIds(result)).toEqual(['fw-new'])
      expect(previousState(result)[0].existed).toBe(false)
    })
  })

  it('updates a rule matched on its name and records its prior body', async () => {
    const live = {
      id: 'fw-1',
      name: 'Block inbound RDP',
      action: 'Allow',
      direction: 'inbound',
      osType: 'windows',
      status: 'Disabled',
    }
    await withFetch([envelope([live]), envelope({})], async (calls) => {
      const result = await deploy(ctx([blockRdp]))

      expect(result.success).toBe(true)
      const puts = callsTo(calls, FIREWALL).filter((call) => call.method === 'PUT')
      expect(puts).toHaveLength(1)
      expect(dataOf(puts[0]).id).toBe('fw-1')
      expect(dataOf(puts[0]).action).toBe('Blocked')
      // The prior ALLOW is what rollback restores — capturing the live rule, not
      // the desired one, is what makes the revert real.
      expect(previousState(result)[0].prior).toEqual(live)
      expect(createdIds(result)).toEqual([])
    })
  })

  it('matches an existing rule whose name differs only by case', async () => {
    await withFetch([envelope([{ id: 'fw-1', name: 'BLOCK INBOUND RDP' }]), envelope({})], async (calls) => {
      await deploy(ctx([blockRdp]))

      expect(callsTo(calls, FIREWALL).filter((call) => call.method === 'PUT')).toHaveLength(1)
      expect(callsTo(calls, FIREWALL).filter((call) => call.method === 'POST')).toHaveLength(0)
    })
  })

  it('reports failure rather than throwing when the vendor rejects a create', async () => {
    await withFetch([envelope([]), apiError('Firewall Control is not licensed', 403)], async () => {
      const result = await deploy(ctx([blockRdp]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/not licensed/)
      expect(createdIds(result)).toEqual([])
    })
  })

  it('reports failure when a create returns no id rather than recording a phantom rule', async () => {
    await withFetch([envelope([]), envelope({})], async () => {
      const result = await deploy(ctx([blockRdp]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/returned no id/)
      expect(previousState(result)).toEqual([])
    })
  })

  it('reports failure when the scoped list itself is rejected', async () => {
    await withFetch([apiError('token lacks scope', 401)], async (calls) => {
      const result = await deploy(ctx([blockRdp]))

      expect(result.success).toBe(false)
      expect(writes(calls)).toHaveLength(0)
    })
  })
})
