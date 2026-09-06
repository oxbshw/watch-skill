/**
 * A Watch Core that stops listening and then keeps running.
 *
 * An engine that has gone silent owes no exit, so nothing can wait for one:
 * whatever ends a connect against this has to end it without a verdict, and
 * has to end it at all. That is the property the test using this asserts, and
 * it holds however the ending is reached.
 *
 * Measured, not assumed: destroying stdin in a Node child has not reached the
 * writer on any platform tested, so in practice the Host's frame lands in a
 * buffer nobody reads and the startup budget settles it rather than a broken
 * pipe. The fixture is kept as the silent-engine case, and the test names both
 * endings so a change in that behaviour is visible rather than silent.
 */
process.stdin.destroy()
// Stay alive, and stay silent. The timer is the process's only reason to live.
setTimeout(() => { process.exit(0) }, 60_000)
