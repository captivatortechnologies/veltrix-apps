import rollback from '../rollback'
import type { PlatformRollbackEntry } from '../deploy'
import {
  API_URL,
  LOGON,
  ok,
  pvwaError,
  recordFetch,
  rollbackContext,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const IMPORTED: PlatformRollbackEntry = { key: 'winsrvcustom', label: 'WinSrvCustom', existed: false, id: 9 }

const REACTIVATED: PlatformRollbackEntry = {
  key: 'winserverlocal',
  label: 'WinServerLocal',
  existed: true,
  id: 3,
  priorActive: false,
}

describe('CyberArk Platforms Rollback Handler', () => {
  it('refuses without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await rollback(rollbackContext({ previousState: [IMPORTED] }, { credential: null }))

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

  it('deletes a platform this deploy imported', async () => {
    const fake = recordFetch([LOGON, ok()])
    try {
      const result = await rollback(rollbackContext({ previousState: [IMPORTED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].url).toBe(`${API_URL}/Platforms/Targets/9`)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('restores the prior active state of a platform this deploy changed', async () => {
    const fake = recordFetch([LOGON, ok()])
    try {
      const result = await rollback(rollbackContext({ previousState: [REACTIVATED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].method).toBe('POST')
      expect(calls[0].url).toBe(`${API_URL}/Platforms/Targets/3/deactivate/`)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('re-activates a platform the deploy had deactivated', async () => {
    const fake = recordFetch([LOGON, ok()])
    try {
      await rollback(rollbackContext({ previousState: [{ ...REACTIVATED, priorActive: true }] }))

      expect(vendorCalls(fake.calls)[0].url).toBe(`${API_URL}/Platforms/Targets/3/activate/`)
    } finally {
      fake.restore()
    }
  })

  it('unwinds in reverse deploy order', async () => {
    const fake = recordFetch([LOGON, ok(), ok()])
    try {
      await rollback(rollbackContext({ previousState: [IMPORTED, REACTIVATED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].url).toBe(`${API_URL}/Platforms/Targets/3/deactivate/`)
      expect(calls[1].url).toBe(`${API_URL}/Platforms/Targets/9`)
    } finally {
      fake.restore()
    }
  })

  it('treats an already-deleted platform (404) as successfully rolled back', async () => {
    const fake = recordFetch([LOGON, pvwaError(404, 'Platform not found')])
    try {
      const result = await rollback(rollbackContext({ previousState: [IMPORTED] }))

      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the delete', async () => {
    const fake = recordFetch([LOGON, pvwaError(409, 'Platform is in use by accounts')])
    try {
      const result = await rollback(rollbackContext({ previousState: [IMPORTED] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Platform is in use by accounts')
    } finally {
      fake.restore()
    }
  })

  it('skips an imported platform whose numeric id was never resolved', async () => {
    const fake = recordFetch([LOGON])
    try {
      const result = await rollback(rollbackContext({ previousState: [{ ...IMPORTED, id: undefined }] }))

      expect(vendorCalls(fake.calls)).toHaveLength(0)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })
})
