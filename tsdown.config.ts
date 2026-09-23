/**
 * tsdown build for @fonlan/dsh-gitmemo: the browser client bundle
 * (lib/client.js, CJS closure factory) replicating the official DSH
 * client-bundle preset (`packages/client/tsdown.client.ts`) the way the
 * proven out-of-tree plugin `@fonlan/dsh-task-kanban` does.
 *
 * The HOST half is NOT built here: `tsc -p tsconfig.json` already emits
 * lib/index.js, lib/cli.js, and the sibling modules plus their declarations, so
 * this config emits exactly one artifact and leaves the rest of `lib` alone
 * (`clean: false` — a clean here would delete the tsc output).
 *
 * The client bundle registers via window.__ModuleLoader__.load({id, factory})
 * with the package-name id `@fonlan/dsh-gitmemo` (the client-modules compose
 * keys on the package name; keep it in sync with package.json `name`).
 * Externals resolve through the loader module table at runtime; everything else
 * is inlined. This page ships no CSS, so no CSS-inline plugin is wired.
 */
import { builtinModules } from 'node:module'
import { dirname, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'

/** Node builtins must never survive into the browser module-loader factory. */
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((id) => `node:${id}`)])

/** Module specifiers the web shell shares into the frozen module table. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client'
]

/** Wire/type layers a client bundle may inline (browser-safe contract surfaces). */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/

const REPOSITORY_ROOT = fileURLToPath(new URL('.', import.meta.url))

/** Rebase a physical lib-relative source onto the repository-shaped URL tree. */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physicalSource = resolvePath(dirname(sourcemapPath), source)
  const repositoryPath = relative(REPOSITORY_ROOT, physicalSource).split(sep).join('/')
  return `../../../${repositoryPath}`
}

/** A rolldown plugin as tsdown's config accepts it (contextual `this` for load/resolveId). */
type BuildPlugin = NonNullable<UserConfig['plugins']>

/** The shared client-bundle purity gate (see the clientBundle doc). */
function purityGatePlugin(): BuildPlugin {
  return {
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (NODE_BUILTINS.has(source)) {
        throw new Error(
          `client bundle purity: Node builtin "${source}" cannot run in the browser module table — `
            + 'select the dependency browser export or add an explicit browser implementation'
        )
      }
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null
      if (INLINE_SAFE.test(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS) and not an inline-safe wire layer — `
          + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)'
      )
    }
  }
}

/** The client bundle build for the official profile channel. */
function clientBundle(pluginId: string, entryFile: string): UserConfig {
  return {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
      'import.meta.resolve': 'undefined'
    },
    inputOptions: {
      resolve: {
        conditionNames: ['browser', 'import', 'require', 'default']
      }
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    plugins: [purityGatePlugin()],
    outputOptions: {
      entryFileNames: entryFile,
      sourcemapPathTransform: browserSourcePath,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false
    }
  }
}

export default [clientBundle('@fonlan/dsh-gitmemo', 'client.js')] satisfies UserConfig[]
