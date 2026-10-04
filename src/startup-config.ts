import { resolveConfig, type ResolvedConfig } from './config.ts'

export interface StartupConfig {
  readonly strategy?: 'activation' | 'replacement' | 'native' | 'off'
  readonly waitForJobs?: boolean
  readonly waitForSubagents?: boolean
  readonly maxHoldMs?: number
}
export interface ResolvedStartupConfig extends ResolvedConfig {
  readonly strategy: NonNullable<StartupConfig['strategy']>
}
export function resolveStartupConfig(config: StartupConfig = {}): ResolvedStartupConfig {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new Error('Startup configuration must be an object')
  const raw = config as Record<string, unknown>
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || !['strategy', 'waitForJobs', 'waitForSubagents', 'maxHoldMs'].includes(key)) throw new Error('Unknown startup configuration option')
  }
  const strategy = config.strategy ?? 'activation'
  if (!['activation', 'replacement', 'native', 'off'].includes(strategy)) throw new Error('Unsupported startup strategy')
  if (strategy === 'native' || strategy === 'off') {
    if (['waitForJobs', 'waitForSubagents', 'maxHoldMs'].some(key => Object.hasOwn(raw, key))) throw new Error('Irrelevant startup configuration option for native/off')
  } else if (strategy === 'replacement' && Object.hasOwn(raw, 'maxHoldMs')) {
    throw new Error('maxHoldMs is an activation-only option')
  }
  return { ...resolveConfig(config), strategy }
}
