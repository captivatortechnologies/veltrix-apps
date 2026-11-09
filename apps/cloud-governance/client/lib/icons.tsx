import React from 'react'

const base = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
}

export const PlayIcon = () => (
  <svg {...base}><polygon points="6 4 20 12 6 20 6 4" /></svg>
)
export const ArrowRightIcon = () => (
  <svg {...base}><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>
)
export const RefreshIcon = () => (
  <svg {...base}><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></svg>
)
export const AlertIcon = () => (
  <svg {...base}><path d="M12 3 2 20h20L12 3z" /><path d="M12 10v4" /><path d="M12 17h.01" /></svg>
)
export const ShieldIcon = () => (
  <svg {...base}><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3z" /></svg>
)
export const ClockIcon = () => (
  <svg {...base}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
)
