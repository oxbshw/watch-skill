/**
 * A Watch Core that starts cleanly and then cannot complete a handshake.
 *
 * The distinction this fixture protects: the process spawned, so it is not
 * missing, and it is not answering, so it is not ready. A product that
 * collapses those two into "disconnected" sends someone to reinstall an
 * engine that is already installed.
 */
process.stdin.resume()
process.stdin.once('data', () => {
  // Read the handshake, answer nothing, and leave.
  process.exit(3)
})
