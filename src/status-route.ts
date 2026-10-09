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
          handler: (_request, response) => {
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
