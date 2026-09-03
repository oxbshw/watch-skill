/**
 * An older Watch Core whose pipe breaks before its exit is delivered.
 *
 * Same engine as `core-without-bridge.mjs` — a usage error and a non-zero exit
 * — with the one ordering that used to change the diagnosis pinned rather than
 * left to the scheduler. Closing stdin first makes the Host's handshake write
 * fail with EPIPE while `close` is still in flight, which is the sequence that
 * happened on macOS and on neither other platform: the write reported
 * `bridge.write_failed`, the Bridge published `handshake_failed`, and a reader
 * was sent to look for a timeout instead of an engine too old to have the
 * command.
 *
 * The delay before exiting is what makes that ordering certain. Without it the
 * test only reproduces the defect on a machine that happens to schedule it.
 */
process.stderr.write("Usage: watch-skill [OPTIONS] COMMAND [ARGS]...\n")
process.stderr.write("Error: No such command 'bridge'.\n")
// Break the parent's write end, so anything it sends fails at once.
process.stdin.destroy()
setTimeout(() => { process.exit(2) }, 150)
