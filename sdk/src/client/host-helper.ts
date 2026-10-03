/** Bundled SDK pages must use the host's typed platform capabilities. */
export function hostHelper<T extends (...args: any[]) => unknown>(name: string, fallback: T): T | undefined {
  const runtime = (globalThis as unknown as { __VELTRIX_APP_RUNTIME__?: { sdk?: Record<string, unknown> } }).__VELTRIX_APP_RUNTIME__
  const helper = runtime?.sdk?.[name]
  // Avoid recursion if a standalone host happens to expose this SDK itself.
  return typeof helper === 'function' && helper !== fallback ? helper as T : undefined
}
