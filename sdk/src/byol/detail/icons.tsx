import React from 'react'

// =============================================================================
// icons — inline SVG icons for the BYOL infrastructure detail sidebar.
//
// These replace the raw Unicode symbol glyphs (◈ ▦ ◷ …) the sidebar used to
// render. Those glyphs only appeared when the active font happened to contain
// them; inside the platform shell (Inter) they collapsed to blank/"tofu", which
// is why the section icons "disappeared" in production. Inline SVGs are
// font-independent, render identically everywhere, need no icon dependency, and
// are CSP-safe (no external asset). They paint with `currentColor`, so each
// icon automatically tracks its button's colour (active = brand, idle = muted).
//
// Paths are the corresponding lucide icons (ISC-licensed), inlined.
// =============================================================================

export interface IconProps {
  /** Square edge length in px. */
  size?: number
  /** Extra styles merged onto the <svg> (colour comes from `currentColor`). */
  style?: React.CSSProperties
}

/** Shared <svg> frame — consistent viewBox, stroke language, and a11y hiding. */
const Svg: React.FC<IconProps & { children: React.ReactNode }> = ({ size = 16, style, children }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    focusable={false}
    style={{ display: 'block', flex: 'none', ...style }}
  >
    {children}
  </svg>
)

/** Overview — dashboard panels. */
export const OverviewIcon: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1" />
    <rect x="14" y="3" width="7" height="5" rx="1" />
    <rect x="14" y="12" width="7" height="9" rx="1" />
    <rect x="3" y="16" width="7" height="5" rx="1" />
  </Svg>
)

/** Resources — stacked servers (the provisioned infrastructure). */
export const ResourcesIcon: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <rect x="2" y="2" width="20" height="8" rx="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" />
    <line x1="6" y1="6" x2="6.01" y2="6" />
    <line x1="6" y1="18" x2="6.01" y2="18" />
  </Svg>
)

/** Activity — the deployment/event pulse. */
export const ActivityIcon: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
  </Svg>
)

/** Access — a key (credentials / who can reach it). */
export const AccessIcon: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <circle cx="7.5" cy="15.5" r="5.5" />
    <path d="m21 2-9.6 9.6" />
    <path d="m15.5 7.5 3 3L22 7l-3-3" />
  </Svg>
)

/** Configuration — sliders (tunable settings that link out to config pages). */
export const ConfigurationIcon: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <line x1="21" y1="4" x2="14" y2="4" />
    <line x1="10" y1="4" x2="3" y2="4" />
    <line x1="21" y1="12" x2="12" y2="12" />
    <line x1="8" y1="12" x2="3" y2="12" />
    <line x1="21" y1="20" x2="16" y2="20" />
    <line x1="12" y1="20" x2="3" y2="20" />
    <line x1="14" y1="2" x2="14" y2="6" />
    <line x1="8" y1="10" x2="8" y2="14" />
    <line x1="16" y1="18" x2="16" y2="22" />
  </Svg>
)

/** Settings — a cog (record-level settings + danger zone). */
export const SettingsIcon: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
)
