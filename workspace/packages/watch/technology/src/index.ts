/**
 * The Technology & Capability Center.
 *
 * DSH owns model providers and credentials; this adds what a chat-endpoint
 * abstraction cannot describe — local engines, capture devices, browser
 * runtimes — and the role bindings that let one connection serve several uses.
 *
 * There is no second credential store and no second provider registry. A
 * descriptor references a DSH credential; it never holds one.
 *
 * @module @watchskill/dsh-technology
 */

export * from './descriptor.js'
export * from './ocr.js'
export * from './ocr-worker.js'
export * from './ocr-qualification.js'
