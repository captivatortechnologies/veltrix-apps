import deploy, { type RecipientRollbackEntry } from '../deploy'
import { RECIPIENTS_UNSUPPORTED_SCOPE_MESSAGE } from '../validate'
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

const CONFIG_TYPE = 's1-notification-recipients'
const RECIPIENTS = '/settings/recipients'

function ctx(sections: CanvasItemInput[], settings?: Record<string, unknown>) {
  return deployContext({ configTypeId: CONFIG_TYPE, sections, settings })
}

function recipient(fields: Record<string, unknown>): CanvasItemInput {
  return { name: `Recipient ${String(fields.email ?? '')}`, fields }
}

const soc = recipient({ email: 'soc@example.com', name: 'SOC Team', sms: '+15550001111' })

function previousState(result: { rollbackData?: unknown }): RecipientRollbackEntry[] {
  return (
    (result.rollbackData as { previousState?: RecipientRollbackEntry[] } | undefined)?.previousState ?? []
  )
}

function createdIds(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdIds?: string[] } | undefined)?.createdIds ?? []
}

function writes(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.method !== 'GET')
}

describe('SentinelOne Notification Recipients Deploy Handler', () => {
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
      const result = await deploy(ctx([soc], SCOPELESS_SETTINGS))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Scope ID/)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses at the group scope, which the recipients endpoint cannot filter', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([soc], { scope: 'group', scope_id: 'grp-1' }))
      expect(result.success).toBe(false)
      expect(result.message).toBe(RECIPIENTS_UNSUPPORTED_SCOPE_MESSAGE)
      expect(calls).toHaveLength(0)
    })
  })

  it('authenticates every request with the API token and lists at the configured scope', async () => {
    await withFetch([envelope([])], async (calls) => {
      await deploy(ctx([]))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe(RECIPIENTS)
      expect(calls[0].authorization).toBe(`ApiToken ${API_TOKEN}`)
      expect(calls[0].url).toContain('accountIds=act-1')
    })
  })

  it('creates a recipient that does not exist yet, scoped by filter', async () => {
    await withFetch([envelope([]), envelope({ id: 'rcp-new' })], async (calls) => {
      const result = await deploy(ctx([soc]))

      expect(result.success).toBe(true)
      const posts = callsTo(calls, RECIPIENTS).filter((call) => call.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(filterOf(posts[0])).toEqual({ accountIds: ['act-1'] })
      expect(dataOf(posts[0])).toEqual({
        email: 'soc@example.com',
        name: 'SOC Team',
        sms: '+15550001111',
      })
      expect(createdIds(result)).toEqual(['rcp-new'])
      expect(previousState(result)[0].existed).toBe(false)
    })
  })

  it('updates a recipient matched on its email and records its prior body', async () => {
    const live = { id: 'rcp-1', email: 'soc@example.com', name: 'Old name', sms: '' }
    await withFetch([envelope([live]), envelope({})], async (calls) => {
      const result = await deploy(ctx([soc]))

      expect(result.success).toBe(true)
      const puts = callsTo(calls, RECIPIENTS).filter((call) => call.method === 'PUT')
      expect(puts).toHaveLength(1)
      expect(dataOf(puts[0])).toEqual({
        id: 'rcp-1',
        email: 'soc@example.com',
        name: 'SOC Team',
        sms: '+15550001111',
      })
      expect(previousState(result)[0].prior).toEqual(live)
      expect(createdIds(result)).toEqual([])
    })
  })

  it('matches an existing recipient whose email differs only by case', async () => {
    await withFetch([envelope([{ id: 'rcp-1', email: 'SOC@EXAMPLE.COM' }]), envelope({})], async (calls) => {
      await deploy(ctx([soc]))

      expect(callsTo(calls, RECIPIENTS).filter((call) => call.method === 'PUT')).toHaveLength(1)
      expect(callsTo(calls, RECIPIENTS).filter((call) => call.method === 'POST')).toHaveLength(0)
    })
  })

  it('reports failure rather than throwing when the vendor rejects a create', async () => {
    await withFetch([envelope([]), apiError('recipient limit reached', 400)], async () => {
      const result = await deploy(ctx([soc]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/recipient limit reached/)
      expect(createdIds(result)).toEqual([])
    })
  })

  it('reports failure when a create returns no id rather than recording a phantom recipient', async () => {
    await withFetch([envelope([]), envelope({})], async () => {
      const result = await deploy(ctx([soc]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/returned no id/)
      expect(previousState(result)).toEqual([])
    })
  })

  it('reports failure when the scoped list itself is rejected', async () => {
    await withFetch([apiError('token lacks scope', 401)], async (calls) => {
      const result = await deploy(ctx([soc]))

      expect(result.success).toBe(false)
      expect(writes(calls)).toHaveLength(0)
    })
  })
})
