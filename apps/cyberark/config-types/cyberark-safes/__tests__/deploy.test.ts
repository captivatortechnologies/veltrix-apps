import deploy from '../deploy'
import {
  API_URL,
  LOGON,
  LOGON_TOKEN,
  MANAGER_USERNAME,
  bodyOf,
  collection,
  created,
  deployContext,
  isLogoff,
  isLogon,
  item,
  leaksToken,
  ok,
  pvwaError,
  recordFetch,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const SAFE = item('Safe 1', {
  safe_name: 'App-Prod',
  description: 'production credentials',
  managing_cpm: 'PasswordManager',
  retention_type: 'days',
  retention_count: 7,
})

/** The same safe as PVWA reports it on GET /Safes, with different managed fields. */
const LIVE_SAFE = {
  safeUrlId: 'App-Prod',
  safeName: 'App-Prod',
  description: 'was something else',
  managingCPM: 'PasswordManager',
  numberOfDaysRetention: 30,
  olacEnabled: true,
  autoPurgeEnabled: true,
}

describe('CyberArk Safes Deploy Handler', () => {
  it('refuses without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await deploy(deployContext([SAFE], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('logs on before the first resource call and sends the raw session token', async () => {
    const fake = recordFetch([LOGON, collection([]), created({ safeUrlId: 'App-Prod' })])
    try {
      await deploy(deployContext([SAFE]))

      expect(isLogon(fake.calls[0])).toBe(true)
      expect(fake.calls[0].method).toBe('POST')
      expect(fake.calls[0].authorization).toBeNull()
      expect(bodyOf(fake.calls[0])).toEqual({
        username: MANAGER_USERNAME,
        password: 'manager-password',
        concurrentSession: true,
      })

      // Every subsequent call carries the token verbatim — PVWA rejects "Bearer".
      for (const call of fake.calls.slice(1)) {
        expect(call.authorization).toBe(LOGON_TOKEN)
      }
    } finally {
      fake.restore()
    }
  })

  it('creates a safe that does not exist yet and records it for rollback', async () => {
    const fake = recordFetch([LOGON, collection([]), created({ safeUrlId: 'App-Prod', safeName: 'App-Prod' })])
    try {
      const result = await deploy(deployContext([SAFE]))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].url).toMatch(`${API_URL}/Safes?`)

      const create = calls[1]
      expect(create.method).toBe('POST')
      expect(create.url).toBe(`${API_URL}/Safes`)
      expect(bodyOf(create)).toEqual({
        safeName: 'App-Prod',
        description: 'production credentials',
        autoPurgeEnabled: false,
        managingCPM: 'PasswordManager',
        numberOfDaysRetention: 7,
        olacEnabled: false,
      })

      expect(result.success).toBe(true)
      const rollback = result.rollbackData as {
        previousState: Array<{ label: string; existed: boolean; safeUrlId?: string }>
        createdSafeUrlIds: string[]
      }
      expect(rollback.previousState).toHaveLength(1)
      expect(rollback.previousState[0].existed).toBe(false)
      expect(rollback.previousState[0].safeUrlId).toBe('App-Prod')
      expect(rollback.createdSafeUrlIds).toEqual(['App-Prod'])
    } finally {
      fake.restore()
    }
  })

  it('updates a safe that already exists and never tries to disable OLAC', async () => {
    const fake = recordFetch([LOGON, collection([LIVE_SAFE]), ok()])
    try {
      const result = await deploy(deployContext([SAFE]))

      const update = vendorCalls(fake.calls)[1]
      expect(update.method).toBe('PUT')
      expect(update.url).toBe(`${API_URL}/Safes/App-Prod`)

      const body = bodyOf(update) as Record<string, unknown>
      expect(body.description).toBe('production credentials')
      expect(body.numberOfDaysRetention).toBe(7)
      // OLAC can be turned on but never off, so an update that does not want it
      // enabled must omit the flag rather than send `false`.
      expect(body.olacEnabled).toBeUndefined()

      expect(result.success).toBe(true)
      const rollback = result.rollbackData as {
        previousState: Array<{ existed: boolean; prior?: { description?: string; numberOfDaysRetention?: number } }>
      }
      expect(rollback.previousState[0].existed).toBe(true)
      expect(rollback.previousState[0].prior?.description).toBe('was something else')
      expect(rollback.previousState[0].prior?.numberOfDaysRetention).toBe(30)
    } finally {
      fake.restore()
    }
  })

  it('sends olacEnabled: true on an update that enables it', async () => {
    const fake = recordFetch([LOGON, collection([{ ...LIVE_SAFE, olacEnabled: false }]), ok()])
    try {
      await deploy(deployContext([item('Safe 1', { ...SAFE.fields, olac_enabled: true })]))

      const body = bodyOf(vendorCalls(fake.calls)[1]) as Record<string, unknown>
      expect(body.olacEnabled).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the create', async () => {
    const fake = recordFetch([LOGON, collection([]), pvwaError(403, 'You are not authorized to add safes')])
    try {
      const result = await deploy(deployContext([SAFE]))

      // A handler that throws surfaces as an opaque pipeline crash; the contract
      // is a DeployResult carrying the vendor's reason.
      expect(result.success).toBe(false)
      expect(result.message).toMatch('You are not authorized to add safes')
      expect(result.message).toMatch(/0 of 1/)
      expect(leaksToken(result)).toBe(false)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when the safe list itself fails', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down')])
    try {
      const result = await deploy(deployContext([SAFE]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('PVWA is down')
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('releases the PVWA session on both the success and the failure path', async () => {
    const good = recordFetch([LOGON, collection([]), created({ safeUrlId: 'App-Prod' })])
    try {
      await deploy(deployContext([SAFE]))
      expect(good.calls.filter(isLogoff)).toHaveLength(1)
    } finally {
      good.restore()
    }

    const bad = recordFetch([LOGON, collection([]), pvwaError(500, 'nope')])
    try {
      await deploy(deployContext([SAFE]))
      expect(bad.calls.filter(isLogoff)).toHaveLength(1)
    } finally {
      bad.restore()
    }
  })

  it('skips an item with no retention count instead of sending a partial safe', async () => {
    const fake = recordFetch([LOGON, collection([])])
    try {
      const result = await deploy(deployContext([item('Safe 1', { safe_name: 'App-Prod' })]))

      expect(result.success).toBe(true)
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })
})
