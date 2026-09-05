/**
 * The browser-safe half of the technology package.
 *
 * `index.ts` re-exports `ocr-worker.js`, which imports `node:child_process`
 * because it supervises a real worker process. That is correct for the host
 * and fatal for a client bundle, so a browser surface that needs the engine
 * descriptors imports this module instead of the package root.
 *
 * Everything here is pure data and pure functions: the descriptors, the role
 * list, the routing rules and the qualification maths. Nothing in it can start
 * a process, and nothing in it reaches the filesystem.
 *
 * @module @deepwatch/dsh-technology/descriptors
 */

export * from './descriptor.js'
export * from './ocr.js'
export * from './ocr-qualification.js'
