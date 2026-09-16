// =============================================================================
// device-assurance-policies — rollback, driven against the fake Okta org.
//
// Rollback removes the posture policies this deploy created and PUTs the ones it
// replaced back to their captured requirements. Okta returns 409 while a policy
// is still mapped to an authentication policy, and that has to reach the operator
// as an instruction, not as an opaque failure.
// =============================================================================

import rollback from '../rollback'
import type { DeviceAssuranceRollbackEntry } from '../deploy'
import {
  API_TOKEN,
  apiError,
  emptyCredential,
  leaksToken,
  notFound,
  ok,
  rollbackContext,
  withFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeOkta'

const PRIOR_BODY = {
  name: 'Managed macOS',
  platform: 'MACOS',
  diskEncryptionType: { include: ['FULL'] },
  screenLockType: { include: ['PASSCODE'] },
}

function created(overrides: Partial<DeviceAssuranceRollbackEntry> = {}): DeviceAssuranceRollbackEntry {
  return { name: 'Managed macOS', existed: false, id: 'dap-NEW', ...overrides }
}

function updated(overrides: Partial<DeviceAssuranceRollbackEntry> = {}): DeviceAssuranceRollbackEntry {
  return { name: 'Managed macOS', existed: true, id: 'dap-1', prior: { ...PRIOR_BODY }, ...overrides }
}

describe('device-assurance-policies rollback', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [created()] }, { credential: null }),
      )
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the credential carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [created()] }, { credential: emptyCredential() }),
      )
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }, { hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports there is nothing to roll back rather than guessing', async () => {
    for (const data of [undefined, {}, { previousState: [] }, { previousState: undefined }]) {
      await withFetch([], async (calls) => {
        const result = await rollback(rollbackContext(data))
        expect(result.success).toBe(false)
        expect(result.message).toBe('No previous state available for rollback')
        expect(calls).toHaveLength(0)
      })
    }
  })

  it('deletes a policy this deploy created', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('DELETE')
      expect(writes[0].path).toBe('/device-assurances/dap-NEW')
      expect(writes[0].authorization).toBe(`SSWS ${API_TOKEN}`)
    })
  })

  it('treats a 404 on the delete as already gone', async () => {
    await withFetch([notFound()], async () => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))
      expect(result.success).toBe(true)
    })
  })

  it('explains that a policy still mapped to an authentication policy cannot be deleted', async () => {
    const result = await withFetch(
      [apiError('Policy is mapped to an authentication policy', 409)],
      async () => rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to delete device assurance policy "Managed macOS"/)
    expect(result.message).toMatch(/remove that mapping first/)
    expect(leaksToken(result)).toBe(false)
  })

  it('does nothing for a created entry whose id was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created({ id: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the captured prior requirements of a policy this deploy updated', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      const restore = writeCalls(calls)[0]
      expect(restore.method).toBe('PUT')
      expect(restore.path).toBe('/device-assurances/dap-1')
      expect(restore.json).toEqual(PRIOR_BODY)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('does nothing for an updated entry whose prior body was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated({ prior: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('undoes policies in reverse order so later changes revert first', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [
            created({ name: 'First', id: 'dap-FIRST' }),
            created({ name: 'Second', id: 'dap-SECOND' }),
          ],
        }),
      )

      expect(result.success).toBe(true)
      expect(calls[0].path).toBe('/device-assurances/dap-SECOND')
      expect(calls[1].path).toBe('/device-assurances/dap-FIRST')
    })
  })

  it('returns a FAILED result rather than throwing when the restore is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore device assurance policy "Managed macOS"/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(
        rollbackContext({
          previousState: [
            created({ name: 'First', id: 'dap-FIRST' }),
            created({ name: 'Second', id: 'dap-SECOND' }),
          ],
        }),
      ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
  })

  it('never puts the SSWS token in its success message', async () => {
    const result = await withFetch([ok({})], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )
    expect(result.success).toBe(true)
    expect(String(result.message).includes(API_TOKEN)).toBe(false)
  })
})
