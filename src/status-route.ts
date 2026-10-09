/**
 * The live driver status, published for the browser half.
 *
 * The status file answers "which driver is really live" for anyone with a
 * shell; the plugin page needs the same answer without one. This registers one
 * exact route on the host web server and serves the record this process last
 * wrote. The route is only registered when the realm has a web server, and it
 * exposes the same facts the file already carries — never configuration.
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { currentGateStatus } from './status.ts'

/** Path the browser half reads the live driver from. */
export const STATUS_PATH = '/goal-wait-gate/status.json'

/**
 * The slice of the host web server this module needs.
 *
 * Declared structurally on purpose: the plugin must not import a web package,
 * and a realm without a web server simply never provides the service.
 */
interface RouteRegistrar {
  register(route: { kind: 'exact'; path: string; handler: (request: unknown, response: RouteResponse) => void }): () => void
}

/** The response surface this handler uses. */
interface RouteResponse {
  writeHead(status: number, headers: Record<string, string>): void
  end(body: string): void
}

/**
 * Register the status route when this realm has a web server.
 *
 * @param ctx - plugin context; `webServer` is injected optionally so a headless
 *   realm starts this plugin unchanged.
 */
/** The mounted row, when this realm has one; the page applies its save through it. */
let liveRow: { applyLive(config: unknown): Promise<void> } | undefined

/**
 * Publish the mounted row so the plugin page can apply the configuration it saved.
 *
 * @param row - the mounted strategy handle.
 */
export function publishLiveRow(row: { applyLive(config: unknown): Promise<void> } | undefined): void {
  liveRow = row
}

/** A request as the host hands it to an exact route. */
interface RouteRequest {
  method?: string
  on(event: string, listener: (chunk?: unknown) => void): void
  setEncoding?(encoding: string): void
}

/** Read a request body to its end. */
function readBody(request: RouteRequest): Promise<string> {
  return new Promise((resolve) => {
    const chunks: string[] = []
    request.setEncoding?.('utf8')
    request.on('data', (chunk?: unknown) => { chunks.push(String(chunk)) })
    request.on('end', () => resolve(chunks.join('')))
    request.on('error', () => resolve(chunks.join('')))
  })
}

/**
 * Apply a configuration the page saved.
 *
 * The page writes a settings document, and a document write leaves a running
 * row on its old configuration -- so the page hands the save back here.
 *
 * @param request - the POST carrying the saved fields.
 * @param response - the reply surface.
 */
async function acceptSavedConfig(request: RouteRequest, response: RouteResponse): Promise<void> {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  try {
    const saved = JSON.parse(await readBody(request)) as Record<string, unknown>
    if (!STRATEGY_NAMES.includes(saved.strategy as string)) throw new Error('unknown strategy "' + String(saved.strategy) + '"')
    if (liveRow === undefined) throw new Error('this realm mounted no row')
    await liveRow.applyLive(saved)
    const status = currentGateStatus()
    response.writeHead(200, headers)
    response.end(JSON.stringify({ ok: true, mounted: status?.mounted ?? 'unknown', requested: status?.requested ?? 'unknown' }))
  } catch (error) {
    response.writeHead(400, headers)
    response.end(JSON.stringify({ ok: false, reason: String(error) }))
  }
}

/** The strategy values the row accepts, mirroring the configuration schema. */
const STRATEGY_NAMES: readonly string[] = ['activation', 'replacement', 'native', 'off']

export function registerStatusRoute(ctx: Context): void {
  ctx.inject(['webServer'], (scoped: Context) => {
    const server = scoped.get('webServer') as RouteRegistrar | undefined
    if (server === undefined) return
    // Best effort: 0.2.1-alpha.2 throws on a duplicate exact path, and this
    // optional surface must never take the driver down with it.
    scoped.effect(() => {
      try {
        return server.register({
          kind: 'exact',
          path: STATUS_PATH,
          handler: (request, response) => {
            const method = (request as RouteRequest).method
            if (method !== undefined && method !== 'GET' && method !== 'HEAD') {
              void acceptSavedConfig(request as RouteRequest, response)
              return
            }
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            response.end(JSON.stringify(currentGateStatus() ?? { mounted: 'unknown' }))
          },
        })
      } catch (error) {
        ctx.logger.warn('goal-wait-gate: the status route could not be registered (' + String(error) + '); the plugin page shows no live driver state')
        return () => {}
      }
    })
  })
}
