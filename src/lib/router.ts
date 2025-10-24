interface Route {
  method: string;
  path: string;
  pattern: RegExp;
  handler: (request: Request, env: Env, ctx: ExecutionContext, params?: Record<string, string>) => Promise<Response>;
}

class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: (request: Request, env: Env, ctx: ExecutionContext, params?: Record<string, string>) => Promise<Response>) {
    // Convert path with parameters to regex
    const pattern = new RegExp('^' + path.replace(/:\w+/g, '([^/]+)') + '$');
    this.routes.push({ method, path, pattern, handler });
  }

  async handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;

    for (const route of this.routes) {
      if (route.method === method) {
        const match = pathname.match(route.pattern);
        if (match) {
          // Extract parameters from the match
          const params: Record<string, string> = {};
          const paramNames = route.path.match(/:\w+/g);
          if (paramNames) {
            paramNames.forEach((paramName, index) => {
              const key = paramName.substring(1); // Remove the ':'
              params[key] = match[index + 1];
            });
          }
          return await route.handler(request, env, ctx, params);
        }
      }
    }

    return new Response('Not Found', { status: 404 });
  }
}

export { Router };
