/**
 * A Watch Core that reports the data directory it was handed, and stops.
 *
 * The engine's data directory arrives through the environment, which is the one
 * part of a spawn a test cannot read from the outside. So this fixture writes
 * what it received to a file the test names, and exits: the question is what
 * reached the child, not what the child then did with it.
 */
import { writeFileSync } from 'node:fs'

writeFileSync(
  process.env.WATCH_ENV_ECHO_OUT ?? 'env-echo.json',
  JSON.stringify({ WATCHSKILL_DATA_DIR: process.env.WATCHSKILL_DATA_DIR ?? null }),
  'utf8',
)
process.exit(0)
