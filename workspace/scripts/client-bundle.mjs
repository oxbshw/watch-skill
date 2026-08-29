/* eslint-disable no-irregular-whitespace --
 * The glob pattern quoted below contains zero-width separators so that the
 * `*` and `/` in it do not close this comment block. They are deliberate, and
 * removing them silently truncates the paragraph that explains why this file
 * exists.
 */
/**
 * Build one Watch browser half into the artifact DeepSeek Harness serves.
 *
 * The plan names this as a real risk: DSH's own client-bundle preset lives
 * inside the monorepo and resolves package manifests by globbing
 * `packages/*​/*​/package.json` from the repository root, so an out-of-tree
 * distribution cannot call it. This is that preset, rewritten against the
 * *artifact contract* rather than against upstream's build layout — which
 * means it is also the thing a third-party Watch capability would use.
 *
 * The contract, read off `@deepseek-ai/dsh-client-modules`:
 *
 * 1. A bundle is a classic script whose only top-level effect is registering
 *    a factory: `window.__ModuleLoader__.load({ id, factory })`. Nothing in
 *    the module body — CSS injection included — may run at script execution;
 *    it runs when the factory is materialized.
 * 2. The factory receives a synchronous `require` bound to the loader's module
 *    table, so the bundle must be CJS.
 * 3. `id` is the package name, and it must match the boot-graph row DSH
 *    composed from the package's `dsh.client` declaration.
 * 4. Only the shell's baseline specifiers plus the package's own
 *    `dsh.client.external` requests may stay external. A `require()` the table
 *    cannot answer is a guaranteed runtime throw, so everything else inlines.
 *
 * CSS Modules are compiled here and injected by the factory under a
 * `data-plugin` tag, so a plugin's styles arrive and leave with the plugin.
 */

import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'

/**
 * Specifiers the shell seeds into the module table for every bundle.
 *
 * Mirrored from `@deepseek-ai/dsh-client-web`'s platform list. Importing that
 * package to read it would make this build script depend on the browser shell,
 * so the list is restated and pinned by the upstream lock instead; the
 * inventory gate is what catches it moving.
 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** Bundles whose factories the parser preloads before the shell starts. */
const PRELOADED = ['@deepseek-ai/dsh-client-runtime/client']

const CSS_MODULE_PREFIX = '\0watch-css-module:'
const CSS_GLOBAL_PREFIX = '\0watch-css-global:'
// The suffix matters: tsdown's own CSS guard matches ids ending in `.css`, so
// the virtual id must not end in one.
const CSS_SUFFIX = '.mjs'

/**
 * Emit the module that injects one stylesheet when the factory runs.
 *
 * The tag id carries the plugin name so its styles are identifiable and
 * removable, and the presence check keeps a reload from stacking duplicates.
 */
function styleModule(pluginId, file, css, classMap) {
  const tagId = `${pluginId}/${basename(file)}`
  const lines = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
    "  const tag = document.createElement('style');",
    `  tag.dataset.plugin = ${JSON.stringify(pluginId)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`,
  ]
  return lines.join('\n')
}

/** Resolve a relative asset import against the importing module. */
function assetPath(source, importer) {
  return resolve(dirname(importer), source)
}

/**
 * Build the tsdown config for one Watch client package.
 *
 * @param {string} packageDir - absolute directory of the package being built.
 * @returns {import('tsdown').UserConfig} the client-bundle config.
 */
export function watchClientBundle(packageDir) {
  const manifest = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'))
  const id = manifest.name
  const requested = new Set([
    ...PLATFORM_MODULES,
    ...PRELOADED,
    ...(manifest.dsh?.client?.external ?? []),
  ])
  const isRequested = specifier => requested.has(specifier)

  return {
    name: `${id}/client`,
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    // Plugin code is fetched outside the shell's module graph, so its own map
    // is the only path from a browser stack frame back to the source.
    sourcemap: true,
    deps: {
      neverBundle: isRequested,
      // Anything the module table cannot answer must inline. A require() it
      // cannot resolve is not a degraded experience, it is a throw.
      alwaysBundle: specifier => !isRequested(specifier),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [
      {
        // The purity gate, build-time mirror of the loader's resolution rules.
        // A cross-plugin value import either inlines a duplicate of a runtime
        // that is supposed to be shared, or requires a specifier the table
        // cannot answer. Both fail at runtime; this fails at build time and
        // says which declaration would fix it.
        name: 'watch-client-bundle-purity',
        resolveId(source) {
          if (!source.startsWith('@deepseek-ai/')) return null
          if (isRequested(source)) return null
          if (/^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/.test(source)) return null
          throw new Error(
            `client bundle purity: ${id} imports "${source}", which is neither a shell baseline `
            + 'module nor one of its dsh.client.external requests. Declare it in dsh.client.external '
            + 'if a package row provides it, or collaborate through a cordis service instead. '
            + '(Type-only imports are erased and never reach this gate.)',
          )
        },
      },
      {
        name: 'watch-css-modules',
        resolveId(source, importer) {
          if (!source.endsWith('.module.css')) return null
          return CSS_MODULE_PREFIX
            + (importer === undefined ? source : assetPath(source, importer))
            + CSS_SUFFIX
        },
        async load(virtualId) {
          if (!virtualId.startsWith(CSS_MODULE_PREFIX)) return null
          const file = virtualId.slice(CSS_MODULE_PREFIX.length, -CSS_SUFFIX.length)
          // The virtual id otherwise hides the real stylesheet from the watcher.
          this.addWatchFile(file)
          const { code, exports } = transform({
            filename: file,
            code: await readFile(file),
            cssModules: { pattern: '[hash]_[local]' },
            minify: true,
          })
          const classMap = {}
          for (const [local, exported] of Object.entries(exports ?? {}).sort()) {
            classMap[local] = exported.name
          }
          return styleModule(id, file, code.toString(), classMap)
        },
      },
      {
        name: 'watch-css-global',
        resolveId(source, importer) {
          if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
          return CSS_GLOBAL_PREFIX
            + (importer === undefined ? source : assetPath(source, importer))
            + CSS_SUFFIX
        },
        async load(virtualId) {
          if (!virtualId.startsWith(CSS_GLOBAL_PREFIX)) return null
          const file = virtualId.slice(CSS_GLOBAL_PREFIX.length, -CSS_SUFFIX.length)
          this.addWatchFile(file)
          const { code } = transform({ filename: file, code: await readFile(file), minify: true })
          return styleModule(id, file, code.toString())
        },
      },
    ],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}
