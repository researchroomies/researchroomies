import { Router } from './lib/router';
import { handleFeaturedConferences, handleConferencePage, handleComponentCreateFormAuth, handleComponentConferenceOptions, handleCreatePost, handlePostShell, handleComponentPost, handleComponentNavUser } from './routes/api';
import { handleAuthStart, handleAuthCallback, handleAuthLogout, handleAuthMe } from './routes/auth';

const router = new Router();

// Register API routes
router.add('GET', '/api/featured-conferences', handleFeaturedConferences);
router.add('GET', '/conference/:slug', handleConferencePage);
router.add('GET', '/api/components/create-form-auth', handleComponentCreateFormAuth);
router.add('GET', '/api/components/conference-options', handleComponentConferenceOptions);
router.add('POST', '/api/post', handleCreatePost);
router.add('GET', '/post/:id', handlePostShell);
router.add('GET', '/api/components/post/:id', handleComponentPost);
router.add('GET', '/api/components/nav-user', handleComponentNavUser);

// Auth routes
router.add('POST', '/api/auth/start', handleAuthStart);
router.add('GET', '/api/auth/callback', handleAuthCallback);
router.add('POST', '/api/auth/logout', handleAuthLogout);
router.add('GET', '/api/auth/me', handleAuthMe);

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		// Handle API routes and dynamic routes (like /conference/:slug and /post/:id)
		if (url.pathname.match(/^\/(api|conference|post)\//)) {
			return await router.handle(request, env, ctx);
		}

		// For other routes, let Cloudflare handle static assets
		// This will serve files from the public directory
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
