import { useAppContext } from './use-app-context'
import type { AppBrandingDeclaration } from '../types/manifest'

/**
 * The app's brand identity as declared in manifest.yaml `branding`.
 *
 * The platform already applies it in the defined slots (the app navbar and
 * the scoped CSS variables --veltrix-app-primary / --veltrix-app-accent on
 * the app page container). Use this hook only when a page needs the values
 * programmatically — prefer the CSS variables for styling:
 *
 * @example
 * ```tsx
 * <span style={{ color: 'var(--veltrix-app-primary)' }}>12 detections</span>
 * ```
 */
export function useAppBranding(): AppBrandingDeclaration | null {
  return useAppContext().branding ?? null
}
