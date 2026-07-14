import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'pipeline/index': 'src/pipeline/index.ts',
    'hooks/index': 'src/hooks/index.ts',
    'client/index': 'src/client/index.ts',
    'ui/index': 'src/ui/index.tsx',
    'byol/index': 'src/byol/index.tsx',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['react'],
})
