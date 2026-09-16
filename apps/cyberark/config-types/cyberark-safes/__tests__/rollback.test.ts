import rollback from '../rollback'
import type { SafeRollbackEntry } from '../deploy'
import {
  API_URL,
  LOGON,
  bodyOf,
  isLogoff,
  ok,
  pvwaError,
  recordFetch,
  rollbackContext,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const CREATED: SafeRollbackEntry = { key: 'app-prod', label: 'App-Prod', existed: false, safeUrlId: 'App-Prod' }

const UPDATED: SafeRollbackEntry = {
  key: 'app-legacy',
  label: 'App-Legacy',
  existed: true,
  safeUrlId: 'App-Legacy',
  prior: {
    safeUrlId: 'App-Legacy',
    safeName: 'App-Legacy',
    description: 'the description it had before',
    managingCPM: 'PasswordManager',
    numberOfVersionsRetention: 5,
    olacEnabled: true,
    autoPurgeEnabled: true,
  },
}

function state(previousState: SafeRollbackEntry[]): unknown {
  return { previousState, createdSafeUrlIds: previousState.filter((e) => !e.existed).map((e) => e.safeUrlId) }
}

describe('CyberArk Safes Rollback Handler', () => {
  it('refuses without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await rollback(rollbackContext(state([CREATED]), { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('refuses when the deployment recorded no previous state', async () => {
    const fake = recordFetch([])
    try {
      const missing = await rollback(rollbackContext(undefined))
      expect(missing.success).toBe(false)
      expect(missing.message).toMatch(/No previous state/)

      const empty = await rollback(rollbackContext({ previousState: [] }))
      expect(empty.success).toBe(false)

      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('deletes a safe this deploy created', async () => {
    const fake = recordFetch([LOGON, ok()])
    try {
      const result = await rollback(rollbackContext(state([CREATED])))

      const calls = vendorCalls(fake.calls)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].url).toBe(`${API_URL}/Safes/App-Prod`)
      expect(result.success).toBe(true)
      expect(result.message).toMatch('App-Prod')
    } finally {
      fake.restore()
    }
  })

  it('restores the prior fields of a safe this deploy updated', async () => {
    const fake = recordFetch([LOGON, ok()])
    try {
      const result = await rollback(rollbackContext(state([UPDATED])))

      const restore = vendorCalls(fake.calls)[0]
      expect(restore.method).toBe('PUT')
      expect(restore.url).toBe(`${API_URL}/Safes/App-Legacy`)

      const body = bodyOf(restore) as Record<string, unknown>
      expect(body.description).toBe('the description it had before')
      expect(body.numberOfVersionsRetention).toBe(5)
      expect(body.autoPurgeEnabled).toBe(true)
      // OLAC cannot be turned off, so a restore never sends it back.
      expect(body.olacEnabled).toBeUndefined()
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('unwinds in reverse deploy order', async () => {
    const fake = recordFetch([LOGON, ok(), ok()])
    try {
      await rollback(rollbackContext(state([CREATED, UPDATED])))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].url).toBe(`${API_URL}/Safes/App-Legacy`)
      expect(calls[1].url).toBe(`${API_URL}/Safes/App-Prod`)
    } finally {
      fake.restore()
    }
  })

  it('treats an already-gone safe (404) as successfully rolled back', async () => {
    const fake = recordFetch([LOGON, pvwaError(404, 'Safe not found')])
    try {
      const result = await rollback(rollbackContext(state([CREATED])))

      expect(result.success).toBe(true)
      expect(result.message).toMatch('App-Prod')
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the delete', async () => {
    const fake = recordFetch([LOGON, pvwaError(403, 'Safe deletion is not permitted')])
    try {
      const result = await rollback(rollbackContext(state([CREATED])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Safe deletion is not permitted')
      expect(fake.calls.filter(isLogoff)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('skips a created safe whose safeUrlId was never captured', async () => {
    const fake = recordFetch([LOGON])
    try {
      const result = await rollback(
        rollbackContext({ previousState: [{ key: 'x', label: 'App-Prod', existed: false }] }),
      )

      expect(vendorCalls(fake.calls)).toHaveLength(0)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })
})
