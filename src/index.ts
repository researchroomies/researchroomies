import { Router } from './lib/router';
import { handleFeaturedConferences } from './routes/api';

const router = new Router();

// Register API routes
router.add('GET', '/api/featured-conferences', handleFeaturedConferences);

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		
		// Handle API routes
		if (url.pathname.startsWith('/api/')) {
			return await router.handle(request, env, ctx);
		}
		
		// For non-API routes, let Cloudflare handle static assets
		// This will serve files from the public directory
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
