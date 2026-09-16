import rollback from '../rollback'
import type { ApplicationRollbackEntry } from '../deploy'
import {
  LEGACY_URL,
  LOGON,
  bodyOf,
  named,
  ok,
  pvwaError,
  recordFetch,
  rollbackContext,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const CREATED: ApplicationRollbackEntry = {
  key: 'aam-payments',
  label: 'AAM-Payments',
  existed: false,
  priorAuthMethods: [],
}

const UPDATED: ApplicationRollbackEntry = {
  key: 'aam-legacy',
  label: 'AAM-Legacy',
  existed: true,
  priorAuthMethods: [{ AuthType: 'machineAddress', AuthValue: '10.0.0.99' }],
}

describe('CyberArk Applications Rollback Handler', () => {
  it('refuses without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }, { credential: null }))

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
      const result = await rollback(rollbackContext({ previousState: [] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/No previous state/)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('deletes an application this deploy created', async () => {
    const fake = recordFetch([LOGON, ok()])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].url).toBe(`${LEGACY_URL}/Applications/AAM-Payments/`)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('restores the exact prior authentication methods of an existing application', async () => {
    const fake = recordFetch([
      LOGON,
      named('authentication', [{ AuthType: 'osUser', AuthValue: 'CORP\\svc_pay', authID: '8' }]),
      ok(),
      ok(),
    ])
    try {
      const result = await rollback(rollbackContext({ previousState: [UPDATED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].url).toBe(`${LEGACY_URL}/Applications/AAM-Legacy/Authentications/`)

      // The method that existed before the deploy comes back...
      expect(calls[1].method).toBe('POST')
      // The captured snapshot carries no IsFolder / AllowInternalScripts, so the
      // restore sends them as their explicit defaults rather than omitting them.
      expect(bodyOf(calls[1])).toEqual({
        authentication: {
          AuthType: 'machineAddress',
          AuthValue: '10.0.0.99',
          IsFolder: false,
          AllowInternalScripts: false,
        },
      })
      // ...and the one the deploy added is removed by its id.
      expect(calls[2].method).toBe('DELETE')
      expect(calls[2].url).toBe(`${LEGACY_URL}/Applications/AAM-Legacy/Authentications/8`)

      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('unwinds in reverse deploy order', async () => {
    const fake = recordFetch([LOGON, named('authentication', []), ok(), ok()])
    try {
      await rollback(rollbackContext({ previousState: [CREATED, UPDATED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].url).toMatch('AAM-Legacy')
      expect(calls[calls.length - 1].url).toBe(`${LEGACY_URL}/Applications/AAM-Payments/`)
    } finally {
      fake.restore()
    }
  })

  it('treats an already-deleted application (404) as successfully rolled back', async () => {
    const fake = recordFetch([LOGON, pvwaError(404, 'Application not found')])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }))

      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the delete', async () => {
    const fake = recordFetch([LOGON, pvwaError(403, 'Not authorized to delete applications')])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Not authorized to delete applications')
    } finally {
      fake.restore()
    }
  })
})
