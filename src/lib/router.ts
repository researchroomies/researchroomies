export type Handler = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  params?: Record<string, string>,
) => Promise<Response>;

interface Route {
  method: string;
  path: string;
  pattern: RegExp;
  handler: Handler;
}

interface MatchedRoute {
  route: Route;
  params: Record<string, string>;
}

class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler) {
    // Convert path with parameters to regex
    const pattern = new RegExp('^' + path.replace(/:\w+/g, '([^/]+)') + '$');
    this.routes.push({ method, path, pattern, handler });
  }

  /**
   * Returns the matching route, or null when nothing matches so the caller can
   * fall through to static assets. Callers must not try to guess whether a path
   * is "dynamic" from its prefix — that guesswork is what stranded /my-posts and
   * /search behind a hand-maintained regex.
   */
  match(method: string, pathname: string): MatchedRoute | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;

      const match = pathname.match(route.pattern);
      if (!match) continue;

      const params: Record<string, string> = {};
      const paramNames = route.path.match(/:\w+/g);
      if (paramNames) {
        paramNames.forEach((paramName, index) => {
          params[paramName.substring(1)] = match[index + 1];
        });
      }

      return { route, params };
    }

    return null;
  }

  async handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const matched = this.match(request.method, url.pathname);

    if (!matched) {
      return new Response('Not Found', { status: 404 });
    }

    return await matched.route.handler(request, env, ctx, matched.params);
  }
}

export { Router };
