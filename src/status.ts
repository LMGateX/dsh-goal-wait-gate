/**
 * Machine-readable record of which goal driver is actually live.
 *
 * The row can ask for `replacement`, but a host this build does not pin, a
 * failed port mount or a foreign driver makes the plugin fall back — and the
 * fallback is activation-shaped, which holds continuation by disarming the
 * goal instead of by simply not queueing a round. Those two behaviours look
 * alike in the transcript, so the plugin writes what it mounted, and why, to a
 * small JSON file beside the DSH home. Losing the file is never fatal: nothing
 * here may influence goal continuation.
 *
 * @module
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Which driver is driving goals right now. */
export type MountedDriver = 'replacement-port' | 'host-driver+gate' | 'host-driver' | 'none'

/** One written status record. */
export interface GateStatus {
  /** ISO-8601 time this record was written. */
  readonly at: string
  /** Strategy the row asked for at that moment. */
  readonly requested: string
  /** Driver that is actually live. */
  readonly mounted: MountedDriver
  /** Why the requested strategy was not honoured, when it was not. */
  readonly fallback?: string
  /** Host identity the ported driver was matched against, when one was matched. */
  readonly host?: { readonly distribution: string; readonly cordis?: string; readonly driverSha256?: string }
}

/** The record this process wrote last, served to the plugin page. */
let latest: GateStatus | undefined

/**
 * The live driver status as this process last wrote it.
 *
 * @returns the last record, or undefined before the first write.
 */
export function currentGateStatus(): GateStatus | undefined {
  return latest
}

/**
 * Where the status record lives: `$DSH_HOME/goal-wait-gate.status.json`,
 * falling back to `~/.dsh` when the launcher exported no home.
 *
 * @param env - environment to read `DSH_HOME` from.
 * @returns absolute path of the status record.
 */
export function gateStatusPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['DSH_HOME'] !== undefined && env['DSH_HOME'] !== '' ? env['DSH_HOME'] : join(homedir(), '.dsh')
  return join(home, 'goal-wait-gate.status.json')
}

/**
 * Write the status record, atomically and best-effort.
 *
 * @param status - record to write.
 * @param path - destination; defaults to {@link gateStatusPath}.
 */
export function writeGateStatus(status: GateStatus, path: string = gateStatusPath()): void {
  // Remembered before the file write so the route serves the truth even when
  // the file cannot be written.
  latest = status
  try {
    mkdirSync(dirname(path), { recursive: true })
    const temporary = path + ".tmp"
    writeFileSync(temporary, JSON.stringify(status, null, 2) + '\n')
    renameSync(temporary, path)
  } catch {
    // Best effort by contract: a status record must never affect continuation.
  }
}
