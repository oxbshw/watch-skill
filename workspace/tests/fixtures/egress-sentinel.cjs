/**
 * A process-level egress sentinel, installed before any product code loads.
 *
 * The governing spec makes this a release blocker (§22.4): "offline tests
 * تسجل egress غير loopback" — if an offline run records non-loopback egress,
 * there is no release. Proving that needs an instrument that cannot be talked
 * past, and the obvious cheap version — stubbing `fetch` — is not one. A module
 * that reaches for `https.request`, an `undici` pool, a raw `net.Socket`, a
 * WebSocket, or a bare DNS lookup goes straight around a `fetch` stub and the
 * test still passes.
 *
 * So this patches the floor instead. In Node every outbound path — `fetch`,
 * `undici`, `axios`, `http`, `https`, `ws`, a hand-rolled socket — ends at
 * `net.Socket.connect` or `tls.connect`, and every hostname that is not already
 * an address ends at `dns.lookup`. Patch those four and there is nothing left
 * to route around inside this process.
 *
 * It is loaded with `node --require`, so it is in place before the first line
 * of product code is evaluated. A test that imported it would be a test the
 * code under test had already run ahead of.
 *
 * Two properties make the result worth anything:
 *
 * **It fails loudly, not quietly.** A non-loopback attempt is recorded *and*
 * the process is killed, so a violation can never be swallowed by a caller's
 * try/catch and reported as a handled error.
 *
 * **It is proven to work.** `WATCH_EGRESS_SELFTEST=1` makes the exercised
 * script attempt one real external connection. A run where the sentinel is
 * silent is only meaningful if a run where it should speak is not.
 */

'use strict'

const net = require('node:net')
const tls = require('node:tls')
const dns = require('node:dns')
const fs = require('node:fs')

/** Where violations are written, so the parent can read them after a kill. */
const LOG = process.env.WATCH_EGRESS_LOG ?? ''

/**
 * Hosts that are the machine talking to itself.
 *
 * Loopback is explicitly permitted by the spec: the Web Host, the Bridge and
 * the Core all live here. Everything else is egress.
 */
const LOOPBACK = new Set([
  '127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost', '0.0.0.0', '',
])

/** Whether a target is the local machine. */
function isLoopback(host) {
  if (host === undefined || host === null) return true
  const value = String(host).toLowerCase().replace(/^\[|\]$/g, '')
  if (LOOPBACK.has(value)) return true
  // The whole 127/8 block, not just 127.0.0.1.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return true
  if (value.endsWith('.localhost')) return true
  return false
}

const violations = []

/** Record one attempt and stop the process. */
function violation(kind, target, detail) {
  const entry = {
    kind,
    target,
    detail: detail ?? '',
    at: new Date().toISOString(),
    // The stack is the useful part: it names the module that tried.
    stack: (new Error('egress').stack ?? '').split('\n').slice(2, 10).join('\n'),
  }
  violations.push(entry)
  if (LOG !== '') {
    try {
      fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`)
    } catch {
      // Nothing useful to do; the exit code still carries the failure.
    }
  }
  process.stderr.write(
    `\nWATCH_EGRESS_VIOLATION ${kind} -> ${String(target)}\n${entry.stack}\n`,
  )
  // Killed rather than thrown. A throw can be caught by the very code that
  // attempted the connection and reported as a handled network error, which is
  // exactly how this proof would quietly stop proving anything.
  process.exit(97)
}

// ── the floor: sockets ──────────────────────────────────────────────────────

const realSocketConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function patchedConnect(...args) {
  const options = typeof args[0] === 'object' && args[0] !== null ? args[0] : {}
  const host = options.host ?? (typeof args[1] === 'string' ? args[1] : undefined)
  // A path means a unix socket or a Windows named pipe: local by definition.
  if (options.path === undefined && !isLoopback(host)) {
    violation('tcp', `${String(host)}:${String(options.port ?? args[0])}`)
  }
  return realSocketConnect.apply(this, args)
}

const realNetConnect = net.connect
net.connect = function patchedNetConnect(...args) {
  const options = typeof args[0] === 'object' && args[0] !== null ? args[0] : {}
  const host = options.host ?? (typeof args[1] === 'string' ? args[1] : undefined)
  if (options.path === undefined && !isLoopback(host)) {
    violation('tcp', `${String(host)}:${String(options.port ?? args[0])}`)
  }
  return realNetConnect.apply(this, args)
}
net.createConnection = net.connect

const realTlsConnect = tls.connect
tls.connect = function patchedTlsConnect(...args) {
  const options = typeof args[0] === 'object' && args[0] !== null ? args[0] : {}
  const host = options.host ?? options.servername
    ?? (typeof args[1] === 'string' ? args[1] : undefined)
  if (options.path === undefined && !isLoopback(host)) {
    violation('tls', `${String(host)}:${String(options.port ?? args[0])}`)
  }
  return realTlsConnect.apply(this, args)
}

// ── the floor: name resolution ──────────────────────────────────────────────
//
// Resolving a hostname is itself egress: it is a UDP packet to a resolver
// carrying the name of the thing being contacted. A run that resolved
// `api.openai.com` and then failed to connect has still told somebody.

function guardResolver(object, name) {
  const real = object[name]
  if (typeof real !== 'function') return
  object[name] = function patchedResolve(hostname, ...rest) {
    if (!isLoopback(hostname)) violation('dns', String(hostname), name)
    return real.call(this, hostname, ...rest)
  }
}

for (const name of [
  'lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname',
  'resolveMx', 'resolveNs', 'resolveSrv', 'resolveTxt',
]) {
  guardResolver(dns, name)
  if (dns.promises !== undefined) guardResolver(dns.promises, name)
}

// ── a belt-and-braces layer above the floor ─────────────────────────────────
//
// Not the proof — the socket and DNS patches are. These catch an attempt
// earlier, with a better stack, and they catch the one case the floor cannot:
// a request to an address literal that some future runtime chooses to route
// without a Socket object this process owns.

const http = require('node:http')
const https = require('node:https')

function guardRequest(module, name, scheme) {
  const real = module[name]
  module[name] = function patchedRequest(...args) {
    const first = args[0]
    let host
    if (typeof first === 'string') {
      try {
        host = new URL(first).hostname
      } catch {
        host = undefined
      }
    } else if (first instanceof URL) {
      host = first.hostname
    } else if (typeof first === 'object' && first !== null) {
      host = first.hostname ?? first.host
    }
    if (host !== undefined && !isLoopback(String(host).split(':')[0])) {
      violation(scheme, String(host), name)
    }
    return real.apply(this, args)
  }
}

guardRequest(http, 'request', 'http')
guardRequest(http, 'get', 'http')
guardRequest(https, 'request', 'https')
guardRequest(https, 'get', 'https')

const realFetch = globalThis.fetch
if (typeof realFetch === 'function') {
  globalThis.fetch = function patchedFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url ?? String(input)
    try {
      const host = new URL(url).hostname
      if (!isLoopback(host)) violation('fetch', host, url)
    } catch {
      // A relative URL cannot leave the machine on its own.
    }
    return realFetch.call(this, input, init)
  }
}

// ── the report ──────────────────────────────────────────────────────────────

process.on('exit', code => {
  if (code === 97) return
  process.stderr.write(
    `WATCH_EGRESS_SUMMARY ${JSON.stringify({ violations: violations.length })}\n`,
  )
})

/**
 * The self-test.
 *
 * A silent sentinel is indistinguishable from an absent one, so the suite runs
 * this arm too and requires it to be caught. If this ever passes, every other
 * offline result in the product is worthless.
 */
if (process.env.WATCH_EGRESS_SELFTEST === '1') {
  process.stderr.write('WATCH_EGRESS_SELFTEST attempting an external connection\n')
  const socket = new net.Socket()
  socket.connect({ host: 'example.com', port: 443 })
}
