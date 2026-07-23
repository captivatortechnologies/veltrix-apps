import React, { useEffect } from 'react'

// A small connectivity status indicator: a coloured dot with a pulsing halo ring
// for live states (online / checking). Themed via the platform's --color-* tokens
// so it adapts to light and dark. The @keyframes are injected into the document
// head once (globally scoped, so every dot on the page shares one definition).

const KEYFRAMES_ID = 'vx-connectivity-dot-keyframes'
const KEYFRAMES = `
@keyframes vxConnectivityPulse {
  0%   { transform: scale(0.6); opacity: 0.55; }
  70%  { transform: scale(2.4); opacity: 0; }
  100% { transform: scale(2.4); opacity: 0; }
}`

function ensureKeyframes(): void {
  if (typeof document === 'undefined' || document.getElementById(KEYFRAMES_ID)) return
  const style = document.createElement('style')
  style.id = KEYFRAMES_ID
  style.textContent = KEYFRAMES
  document.head.appendChild(style)
}

export type ConnectivityState = 'online' | 'offline' | 'checking'

const COLOR: Record<ConnectivityState, string> = {
  online: 'rgb(var(--color-success))',
  offline: 'rgb(var(--color-danger))',
  checking: 'rgb(var(--color-warning))',
}

const DEFAULT_LABEL: Record<ConnectivityState, string> = {
  online: 'Online',
  offline: 'Offline',
  checking: 'Checking…',
}

interface ConnectivityDotProps {
  state: ConnectivityState
  /** Tooltip / accessible label; defaults to the state name. */
  label?: string
  /** Outer size in px (the halo diameter). Default 10. */
  size?: number
}

/** Animated connectivity status dot (online pulses green, offline is a static red, checking pulses amber). */
export default function ConnectivityDot({ state, label, size = 10 }: ConnectivityDotProps) {
  useEffect(() => {
    ensureKeyframes()
  }, [])

  const color = COLOR[state]
  const text = label ?? DEFAULT_LABEL[state]
  const animate = state === 'online' || state === 'checking'
  const core = Math.max(4, Math.round(size * 0.7))

  return (
    <span
      role="img"
      aria-label={text}
      title={text}
      style={{ position: 'relative', display: 'inline-flex', width: size, height: size, alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}
    >
      {animate && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            width: size,
            height: size,
            borderRadius: '50%',
            background: color,
            animation: 'vxConnectivityPulse 1.8s ease-out infinite',
          }}
        />
      )}
      <span
        aria-hidden
        style={{
          position: 'relative',
          width: core,
          height: core,
          borderRadius: '50%',
          background: color,
          boxShadow: '0 0 0 2px rgb(var(--color-surface-raised))',
        }}
      />
    </span>
  )
}
