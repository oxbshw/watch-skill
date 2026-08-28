// A Core that speaks the framing correctly for the handshake, then misbehaves
// in whatever way the test asked for.
const MODE = process.argv[2] ?? 'none'

// Optional: a file every spawn appends its pid to.
//
// Counting operating-system processes from a test is fragile and differs per
// platform. Counting lines in a file the fixture itself writes is neither, and
// it answers the only question that matters — how many Cores were started.
const SPAWN_LOG = process.argv[3] ?? ''
if (SPAWN_LOG !== '') {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(SPAWN_LOG, String(process.pid) + '\n')
}

const T = '\r\n\r\n'
let buffer = Buffer.alloc(0)

const send = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  process.stdout.write(`Content-Length: ${body.byteLength}${T}`)
  process.stdout.write(body)
}

function handle(message) {
  if (message.method === 'watch.handshake' && MODE === 'silent-handshake') {
    // Answer nothing. The startup deadline is what has to end this.
    return
  }
  if (message.method === 'watch.handshake' && MODE === 'slow-handshake') {
    setTimeout(() => {
      send({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, coreVersion: '0.0.0-hostile', capabilities: {}, contracts: {},
      } })
    }, 2500)
    return
  }
  if (message.method === 'watch.handshake') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: 1, coreVersion: '0.0.0-hostile', capabilities: {}, contracts: {},
    } })
    return
  }
  if (message.id === undefined) return

  if (MODE === 'crash-after-ready') {
    // Handshake fine, then die on the first real request. Every reconnect
    // after this handshakes and dies again.
    process.exit(7)
  }

  if (MODE === 'huge-frame') {
    // Declares a gigabyte and sends nine bytes.
    process.stdout.write(`Content-Length: 1073741824${T}`)
    process.stdout.write('{"a":1}  ')
    return
  }
  if (MODE === 'duplicate') {
    send({ jsonrpc: '2.0', id: message.id, result: { which: 'first' } })
    send({ jsonrpc: '2.0', id: message.id, result: { which: 'second' } })
    return
  }
  if (MODE === 'unknown-id') {
    send({ jsonrpc: '2.0', id: 999999, result: { stray: true } })
    send({ jsonrpc: '2.0', id: message.id, result: { which: 'real' } })
    return
  }
  if (MODE === 'garbage') {
    const body = Buffer.from('this is not json', 'utf8')
    process.stdout.write(`Content-Length: ${body.byteLength}${T}`)
    process.stdout.write(body)
    return
  }
  if (MODE === 'no-header') {
    process.stdout.write(`X-Nonsense: 1${T}`)
    process.stdout.write('{}')
    return
  }
  if (MODE === 'event-flood') {
    for (let n = 0; n < 200; n += 1) send({ jsonrpc: '2.0', method: 'watch.progress', params: { n } })
    send({ jsonrpc: '2.0', id: message.id, result: { flooded: 200 } })
    return
  }
  send({ jsonrpc: '2.0', id: message.id, result: { ok: true } })
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf(T)
    if (headerEnd < 0) return
    const header = buffer.subarray(0, headerEnd).toString('ascii')
    const match = /content-length:\s*(\d+)/i.exec(header)
    if (match === null) process.exit(9)
    const bodyStart = headerEnd + T.length
    const bodyEnd = bodyStart + Number(match[1])
    if (buffer.byteLength < bodyEnd) return
    handle(JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString('utf8')))
    buffer = buffer.subarray(bodyEnd)
  }
})
process.stdin.resume()
