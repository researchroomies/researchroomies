interface Route {
  method: string;
  path: string;
  handler: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
}

class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>) {
    this.routes.push({ method, path, handler });
  }

  async handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;

    for (const route of this.routes) {
      if (route.method === method && route.path === pathname) {
        return await route.handler(request, env, ctx);
      }
    }

    return new Response('Not Found', { status: 404 });
  }
}

export { Router };
