import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { ClusterPlacementField } from '../ClusterPlacementField'
import type { ClusterPlacement } from '../types'

const regionOptions = [
  { value: 'us-east-1', label: 'us-east-1' },
  { value: 'us-west-2', label: 'us-west-2' },
]

function renderField(placement: ClusterPlacement, onChange = vi.fn(), nodeCount = 4) {
  render(
    <ClusterPlacementField
      label="Indexer placement"
      placement={placement}
      nodeCount={nodeCount}
      primaryRegion="us-east-1"
      regionOptions={regionOptions}
      onChange={onChange}
    />,
  )
  return onChange
}

describe('ClusterPlacementField', () => {
  it('single-site placement shows no site editor', () => {
    renderField({ mode: 'single' })
    expect(screen.queryByText('Add site')).toBeNull()
  })

  it('multi-site placement shows a live per-site node preview', () => {
    renderField({
      mode: 'multi-site',
      granularity: 'az',
      sites: [
        { site: 'us-east-1a', percent: 50 },
        { site: 'us-east-1b', percent: 50 },
      ],
    })
    // 4 nodes split 50/50 → 2 nodes each.
    expect(screen.getAllByText(/→ 2 nodes/)).toHaveLength(2)
    expect(screen.getByText(/2 sites · 4 of 4 nodes placed/)).toBeTruthy()
  })

  it('surfaces a validation error when percentages do not total 100', () => {
    renderField({
      mode: 'multi-site',
      granularity: 'az',
      sites: [
        { site: 'us-east-1a', percent: 60 },
        { site: 'us-east-1b', percent: 30 },
      ],
    })
    expect(screen.getByText(/total 100/)).toBeTruthy()
  })

  it('adds a site when "Add site" is clicked', () => {
    const onChange = renderField({
      mode: 'multi-site',
      granularity: 'az',
      sites: [
        { site: 'us-east-1a', percent: 50 },
        { site: 'us-east-1b', percent: 50 },
      ],
    })
    fireEvent.click(screen.getByText('Add site'))
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0] as ClusterPlacement
    expect(next.sites).toHaveLength(3)
  })

  it('distributes percentages evenly', () => {
    const onChange = renderField({
      mode: 'multi-site',
      granularity: 'az',
      sites: [
        { site: 'us-east-1a', percent: 80 },
        { site: 'us-east-1b', percent: 20 },
      ],
    })
    fireEvent.click(screen.getByText('Distribute evenly'))
    const next = onChange.mock.calls[0][0] as ClusterPlacement
    expect(next.sites?.map((s) => s.percent)).toEqual([50, 50])
  })
})
