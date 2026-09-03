/**
 * A Watch Core that closes its stdin and then keeps running.
 *
 * The counterfactual for the wait a broken pipe now does: a write that fails
 * because the child is gone can ask the child's exit why, but a write that
 * fails because the child stopped listening is owed no exit at all. This
 * fixture never provides one, so the bound on that wait is the only thing that
 * ends it — and if the bound were removed, the request here would sit until its
 * deadline instead of failing in well under a second.
 */
process.stdin.destroy()
// Stay alive, and stay silent. The timer is the process's only reason to live.
setTimeout(() => { process.exit(0) }, 60_000)
