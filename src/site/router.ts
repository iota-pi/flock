/*
 * The Cloudflare Worker in front of the site's static files (sst.config.ts). Cloudflare serves files
 * that exist and answers page navigations with the app shell itself, so this only sees other
 * requests for paths with no file behind them.
 *
 * Passed through, a missing script would get the app shell with status 200, and the /assets/* rule
 * in public/_headers would mark that immutable for a year, so a browser that asked for a file before
 * a deploy reached it would keep the page in its place. A real 404 that nobody caches avoids both.
 */
import { isPageInPlaceOfFile } from '../utils/builtAssets'

export type SiteEnv = {
  ASSETS: { fetch: (request: Request) => Promise<Response> },
}

export async function handleSiteRequest(request: Request, env: SiteEnv): Promise<Response> {
  const response = await env.ASSETS.fetch(request)
  if (isPageInPlaceOfFile(request.url, response)) {
    return new Response('Not found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
  return response
}

export default { fetch: handleSiteRequest }
