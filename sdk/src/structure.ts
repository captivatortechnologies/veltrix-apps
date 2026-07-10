// ========================================================================
// Canonical app layout
//
// Every Veltrix app follows one predictable folder structure so apps are
// easy to set up, review, and load. The `veltrix` CLI scaffolds it,
// `veltrix validate` (and repo CI) warn on deviations, and the platform's
// app engine resolves manifest references against it.
// ========================================================================

/** Canonical locations inside an app directory. */
export const APP_LAYOUT = {
  /** The app contract. Always at the app root. */
  manifest: 'manifest.yaml',
  /**
   * The unit of extension: config-types/<configTypeId>/ colocates everything
   * for one configuration type — canvas.yaml, defaults.yaml, the six pipeline
   * handlers (extensionless in the manifest), and __tests__/.
   */
  configTypesDir: 'config-types',
  /** Canvas form schema filename inside a config-type folder. */
  canvasFile: 'canvas.yaml',
  /** Default field values filename inside a config-type folder. */
  defaultsFile: 'defaults.yaml',
  /** Lifecycle hooks (camelCase): hooks/onInstall, hooks/onUninstall, ... */
  hooksDir: 'hooks',
  /** Shared app code used by multiple handlers (API clients, parsers). */
  libDir: 'lib',
  /** SQL migrations (requires manifest `database.tablePrefix`). */
  migrationsDir: 'migrations',
  /** Fastify route module receiving (fastify, AppRouteContext). */
  serverEntry: 'server/index',
  /** Client entry registering pages/sidebar items (optional). */
  clientEntry: 'client/index',
  /** Icons and logos (optional). */
  assetsDir: 'assets',
  /** Tests live next to the code they cover: handlers/<id>/__tests__/ */
  testsDirName: '__tests__',
} as const

/** The six pipeline handler names, in lifecycle order. */
export const HANDLER_NAMES = [
  'validate',
  'deploy',
  'rollback',
  'healthCheck',
  'driftDetect',
  'getStatus',
] as const

export type HandlerName = (typeof HANDLER_NAMES)[number]

/**
 * Conventional manifest paths for one configuration type — handy when
 * generating or checking a manifest programmatically.
 *
 * @example
 * conventionalPaths('indexes').handlers.deploy // 'config-types/indexes/deploy'
 */
export function conventionalPaths(configTypeId: string): {
  canvasTemplate: string
  defaultConfig: string
  handlers: Record<HandlerName, string>
} {
  const base = `${APP_LAYOUT.configTypesDir}/${configTypeId}`
  const handlers = {} as Record<HandlerName, string>
  for (const name of HANDLER_NAMES) {
    handlers[name] = `${base}/${name}`
  }
  return {
    canvasTemplate: `${base}/${APP_LAYOUT.canvasFile}`,
    defaultConfig: `${base}/${APP_LAYOUT.defaultsFile}`,
    handlers,
  }
}
