// Unit tests for the BYOL node-hours meter (the pure, billable core).
// Jest-shaped globals (describe/it/expect) are injected by the repo runner
// (scripts/test-apps.mjs → esbuild + node:test); @types/jest supplies their
// types for `tsc --noEmit`. Run: `node scripts/test-apps.mjs splunk-enterprise`.
import { computeNodeHours, type StatePoint } from '../usage/collector'

const D = (iso: string) => new Date(iso)
const dayStart = D('2026-07-14T00:00:00.000Z')
const dayEnd = D('2026-07-15T00:00:00.000Z')

describe('computeNodeHours', () => {
  it('running all day bills 24h × node count', () => {
    const events: StatePoint[] = [{ status: 'running', nodeCount: 3, at: D('2026-07-13T10:00:00.000Z') }]
    expect(computeNodeHours(events, dayStart, dayEnd)).toBe(72) // 24 × 3
  })

  it('started mid-day bills only from the running event', () => {
    const events: StatePoint[] = [
      { status: 'provisioning', nodeCount: 2, at: D('2026-07-14T06:00:00.000Z') },
      { status: 'running', nodeCount: 2, at: D('2026-07-14T12:00:00.000Z') },
    ]
    expect(computeNodeHours(events, dayStart, dayEnd)).toBe(24) // 12h × 2
  })

  it('stopped mid-day stops accrual', () => {
    const events: StatePoint[] = [
      { status: 'running', nodeCount: 4, at: D('2026-07-13T00:00:00.000Z') },
      { status: 'stopped', nodeCount: 4, at: D('2026-07-14T06:00:00.000Z') },
    ]
    expect(computeNodeHours(events, dayStart, dayEnd)).toBe(24) // 6h × 4
  })

  it('node-count change mid-day is respected', () => {
    const events: StatePoint[] = [
      { status: 'running', nodeCount: 2, at: D('2026-07-13T00:00:00.000Z') },
      { status: 'running', nodeCount: 5, at: D('2026-07-14T12:00:00.000Z') },
    ]
    expect(computeNodeHours(events, dayStart, dayEnd)).toBe(84) // 12h×2 + 12h×5
  })

  it('never running bills nothing', () => {
    const events: StatePoint[] = [{ status: 'stopped', nodeCount: 3, at: D('2026-07-13T00:00:00.000Z') }]
    expect(computeNodeHours(events, dayStart, dayEnd)).toBe(0)
  })

  it('no events bills nothing', () => {
    expect(computeNodeHours([], dayStart, dayEnd)).toBe(0)
  })
})
