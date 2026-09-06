/**
 * An older Watch Core that holds the broken-pipe window open.
 *
 * Same engine as `core-without-bridge.mjs` — a usage error and a non-zero exit
 * — with the gap the defect lives in made as wide as a fixture can make it.
 * Closing stdin first removes the read end early; waiting before exiting keeps
 * `close`, the event carrying the exit code and the argument parser's own
 * words, from arriving for another 150ms. In between, a write from the Host
 * has nothing to write to and no verdict to quote.
 *
 * It widens that window; it cannot guarantee the Host writes inside it. When
 * the handshake write happens is decided by when Node delivers `spawn`, and on
 * every platform measured so far that has been early enough for the write to
 * land before this fixture closes anything. The reproduction on macOS was a
 * loaded runner delivering `spawn` late, which is not something a fixture can
 * ask for.
 */
process.stderr.write("Usage: watch-skill [OPTIONS] COMMAND [ARGS]...\n")
process.stderr.write("Error: No such command 'bridge'.\n")
// Drop the read end early, so a write in the window has nowhere to go.
process.stdin.destroy()
setTimeout(() => { process.exit(2) }, 150)
