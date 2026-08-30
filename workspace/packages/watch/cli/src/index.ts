/**
 * The DeepWatch CLI, as a library.
 *
 * The executable is `bin.js`; this is what a test or another tool imports. The
 * separation matters: `bin.js` reads `process.argv` and sets an exit code, and
 * neither is a thing a caller should have to simulate to check a decision.
 *
 * @module @deepwatch/cli
 */

export { doctor, renderDoctor } from './doctor.js'
export type { Availability, DoctorReport, Finding } from './doctor.js'
export { parse } from './bin.js'
export type { Invocation } from './bin.js'
export { deepwatchHome, dshHome, profileName, stateRoot, watchCoreBin } from './lib/paths.js'
export { VERSION } from './version.js'
