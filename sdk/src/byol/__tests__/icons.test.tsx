import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import React from 'react'
import {
  OverviewIcon,
  ResourcesIcon,
  ActivityIcon,
  AccessIcon,
  ConfigurationIcon,
  SettingsIcon,
  type IconProps,
} from '../detail/icons'

const ICONS: Array<[string, React.FC<IconProps>]> = [
  ['Overview', OverviewIcon],
  ['Resources', ResourcesIcon],
  ['Activity', ActivityIcon],
  ['Access', AccessIcon],
  ['Configuration', ConfigurationIcon],
  ['Settings', SettingsIcon],
]

describe('BYOL section icons', () => {
  it.each(ICONS)('%s renders an inline SVG that inherits colour + is a11y-hidden', (_name, Icon) => {
    const { container } = render(<Icon />)
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    // currentColor → the icon tracks the button's text colour (active/idle).
    expect(svg?.getAttribute('stroke')).toBe('currentColor')
    // decorative — the button's title/label is the accessible name.
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
  })

  it('honours the size prop', () => {
    const { container } = render(<OverviewIcon size={28} />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('28')
    expect(svg?.getAttribute('height')).toBe('28')
  })
})
