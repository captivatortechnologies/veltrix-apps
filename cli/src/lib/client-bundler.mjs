// ============================================================================
// App client bundler — compiles an app's client entry into a hermetic ESM
// bundle the platform can serve to browsers.
//
// The bundle must run inside the platform's React tree, so `react`,
// `react-dom`, `react/jsx-runtime`, and every `@veltrixsecops/app-sdk`
// subpath are replaced with shims that read the host-provided runtime from
// `globalThis.__VELTRIX_APP_RUNTIME__` (see @veltrixsecops/app-sdk/client).
// Because those are the only non-relative imports a typical app client has,
// bundling needs no node_modules — packaging stays hermetic in CI.
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'

export const HOST_RUNTIME_GLOBAL = '__VELTRIX_APP_RUNTIME__'

/** Relative output path of the client bundle inside a packaged app. */
export const CLIENT_BUNDLE_PATH = 'client/dist/index.mjs'

/** Module specifiers replaced with host-runtime shims, and the runtime
 * property each one re-exports. */
const SHIM_PROPS = {
  react: 'react',
  'react-dom': 'reactDom',
  'react-dom/client': 'reactDomClient',
  'react/jsx-runtime': 'jsxRuntime',
  'react/jsx-dev-runtime': 'jsxRuntime',
  '@veltrixsecops/app-sdk': 'sdk',
  '@veltrixsecops/app-sdk/hooks': 'sdk',
  '@veltrixsecops/app-sdk/client': 'sdk',
}

const SHIM_FILTER =
  /^(react|react-dom|react-dom\/client|react\/jsx-runtime|react\/jsx-dev-runtime|@veltrixsecops\/app-sdk(\/(hooks|client))?)$/

function hostShimPlugin() {
  return {
    name: 'veltrix-host-shims',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: SHIM_FILTER }, (args) => ({
        path: args.path,
        namespace: 'veltrix-host-shim',
      }))
      // CJS shim bodies — esbuild's interop turns named imports into
      // property accesses on the host module object.
      pluginBuild.onLoad({ filter: /.*/, namespace: 'veltrix-host-shim' }, (args) => ({
        contents:
          `const rt = globalThis.${HOST_RUNTIME_GLOBAL}\n` +
          `if (!rt) throw new Error('Veltrix host runtime not found — app client bundles only run inside the Veltrix platform')\n` +
          `module.exports = rt.${SHIM_PROPS[args.path]}\n`,
        loader: 'js',
      }))
    },
  }
}

/**
 * Resolve a manifest's extensionless client entry (e.g. "client/index")
 * to a real file. Returns null when the app has no resolvable entry.
 */
export function resolveClientEntry(appRoot, entry) {
  if (!entry) return null
  const base = path.resolve(appRoot, entry)
  const candidates = [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    `${base}.jsx`,
    `${base}.js`,
    path.join(base, 'index.tsx'),
    path.join(base, 'index.ts'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

/**
 * Bundle an app's client entry to `<appRoot>/client/dist/index.mjs`.
 * `nodePaths` may point at the app's real node_modules so apps that bundle
 * extra client-side dependencies still resolve them when packaging locally.
 * Returns the output path, or null when the app declares no client entry.
 */
export async function bundleAppClient({ appRoot, entry, nodePaths = [], write = true }) {
  const entryFile = resolveClientEntry(appRoot, entry)
  if (!entryFile) return null

  const outFile = path.join(appRoot, CLIENT_BUNDLE_PATH)
  await build({
    entryPoints: [entryFile],
    outfile: outFile,
    // Paths in output comments are printed relative to this — without it the
    // (temp) staging path leaks into the bundle and breaks reproducibility.
    absWorkingDir: appRoot,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    logLevel: 'warning',
    nodePaths,
    write,
    plugins: [hostShimPlugin()],
  })
  return outFile
}
