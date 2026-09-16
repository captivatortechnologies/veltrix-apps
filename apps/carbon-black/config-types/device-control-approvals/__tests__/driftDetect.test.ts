import driftDetect from '../driftDetect'
import {
  AUTH_TOKEN,
  EMPTY_SEARCH,
  NO_BASE_URL_SETTINGS,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  driftContext,
  searchPage,
  withFetch,
  type ItemInput,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'device-control-approvals'
const APPROVALS = `/device_control/v3/orgs/${ORG_KEY}/approvals`

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function approval(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.approvalName ?? ''), fields }
}

const DEPLOYED = approval({
  approvalName: 'Sandisk Cruzer',
  notes: 'IT approved',
  vendorId: '0x0781',
  productId: '0x5581',
  serialNumber: 'SN1',
})

const IN_SYNC = {
  id: 'ap-1',
  approval_name: 'Sandisk Cruzer',
  notes: 'IT approved',
  vendor_id: '0x0781',
  product_id: '0x5581',
  serial_number: 'SN1',
}

function fields(result: { diffs: Array<{ field: string }> }): string[] {
  return result.diffs.map((d) => d.field)
}

describe('carbon-black device-control-approvals driftDetect handler', () => {
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

  it('reports no drift when the region base URL is blank', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { settings: NO_BASE_URL_SETTINGS }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('finds no drift when the live approval matches what was deployed', async () => {
    await withFetch([searchPage([IN_SYNC])], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe(`${APPROVALS}/_search`)
      expect(calls[0].authToken).toBe(AUTH_TOKEN)
    })
  })

  it('flags a deleted approval as critical — that device is blocked again', async () => {
    await withFetch([EMPTY_SEARCH], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('Sandisk Cruzer')
      expect(result.diffs[0].expected).toBe('present')
      expect(result.diffs[0].actual).toBe('absent')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('flags the approval being renamed out of band', async () => {
    await withFetch([searchPage([{ ...IN_SYNC, approval_name: 'Renamed by hand' }])], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Sandisk Cruzer.approval_name')!
      expect(diff.expected).toBe('Sandisk Cruzer')
      expect(diff.actual).toBe('Renamed by hand')
      expect(diff.severity).toBe('warning')
    })
  })

  it('flags edited notes and a rename together', async () => {
    await withFetch(
      [searchPage([{ ...IN_SYNC, approval_name: 'Renamed', notes: 'edited' }])],
      async () => {
        const result = await driftDetect(ctx([DEPLOYED]))

        expect(result.hasDrift).toBe(true)
        expect(result.diffs).toHaveLength(2)
        expect(fields(result)).toContain('Sandisk Cruzer.approval_name')
        expect(fields(result)).toContain('Sandisk Cruzer.notes')
      },
    )
  })

  it('treats notes cleared on the vendor side as drift against the deployed text', async () => {
    const live = {
      id: 'ap-1',
      approval_name: 'Sandisk Cruzer',
      vendor_id: '0x0781',
      product_id: '0x5581',
      serial_number: 'SN1',
    }
    await withFetch([searchPage([live])], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Sandisk Cruzer.notes')!
      expect(diff.expected).toBe('IT approved')
      expect(diff.actual).toBe('')
    })
  })

  it('matches on the device tuple, not the name — a same-named approval for another device is absent', async () => {
    await withFetch([searchPage([{ ...IN_SYNC, serial_number: 'SOMEOTHERSTICK' }])], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('Sandisk Cruzer')
      expect(result.diffs[0].actual).toBe('absent')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('matches the device tuple case-insensitively', async () => {
    await withFetch([searchPage([{ ...IN_SYNC, serial_number: 'sn1' }])], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
    })
  })

  it('ignores an item that names no device at all rather than calling it absent', async () => {
    await withFetch([EMPTY_SEARCH], async () => {
      const result = await driftDetect(ctx([approval({ approvalName: 'No selector' })]))

      // Deploy never sends a selector-less item, so drift must not report one missing.
      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })

  it('reports no drift when the vendor listing fails, rather than inventing absences', async () => {
    await withFetch([cbError('service unavailable', 503)], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      // A handler that cannot read live state must not claim everything is gone.
      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })
})
