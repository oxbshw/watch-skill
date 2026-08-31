/**
 * A Watch Core old enough to predate the Bridge surface.
 *
 * It behaves exactly as an argument parser does when handed a subcommand it
 * has never heard of: a usage error on stderr and a non-zero exit. That pair
 * is the only signal the Host has for telling "your engine is too old" apart
 * from "your engine crashed", and the two need opposite fixes.
 */
process.stderr.write("Usage: watch-skill [OPTIONS] COMMAND [ARGS]...\n")
process.stderr.write("Error: No such command 'bridge'.\n")
process.exit(2)
