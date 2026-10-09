/**
 * Test setup: every suite writes its status record under a scratch home.
 *
 * The plugin records which goal driver is live beside the DSH home. An inherited
 * `DSH_HOME` is the developer's live instance, and a test run must never
 * overwrite the record it is being developed against — including suites that
 * never import the plugin harness.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env['DSH_HOME'] = mkdtempSync(join(tmpdir(), 'gate-home-'))
