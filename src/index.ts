import { Router } from './lib/router';
import { handleFeaturedConferences, handleConferencePage } from './routes/api';

const router = new Router();

// Register API routes
router.add('GET', '/api/featured-conferences', handleFeaturedConferences);
router.add('GET', '/conference/:slug', handleConferencePage);

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		
		// Handle API routes and dynamic routes (like /conference/:slug)
		if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/conference/')) {
			return await router.handle(request, env, ctx);
		}
		
		// For other routes, let Cloudflare handle static assets
		// This will serve files from the public directory
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
