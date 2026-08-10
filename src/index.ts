import { createRouter } from './routes';

// The route table itself lives in ./routes so tests can import it. See ROUTES.
const router = createRouter();

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		// Ask the router itself whether it owns this path. This was once a
		// hand-maintained path-prefix regex that every new route had to be added
		// to by hand — forgetting to was a silent 404.
		const matched = router.match(request.method, url.pathname);
		if (matched) {
			return await matched.route.handler(request, env, ctx, matched.params);
		}

		// Routes are registered without a trailing slash, so /search/ used to fall
		// straight through to the 404 page. That URL is not hypothetical: Eleventy
		// emitted directory-style pages, so /search/ is where the old static search
		// page lived, and it survives in bookmarks, history and URL autocomplete.
		//
		// Only redirect when trimming actually reveals a Worker route: real assets
		// ARE directory-style (/about/, /login/), and those must be left alone.
		// 308 rather than 301 preserves the method, so POST routes such as
		// /post/:id/edit/ do not silently degrade into a GET.
		if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
			const trimmed = url.pathname.replace(/\/+$/, '');
			if (trimmed && router.match(request.method, trimmed)) {
				const target = new URL(url);
				target.pathname = trimmed;
				return Response.redirect(target.href, 308);
			}
		}

		// Anything else is a static asset built by Eleventy into public/.
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
