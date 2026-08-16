import { Router, type Handler } from './lib/router';
import { handleFeaturedConferences, handleAllConferences, handleConferencePage } from './routes/conferences';
import { handleSubjectPage } from './routes/subjects';
import { handleSearch } from './routes/search';
import {
	handleComponentCreateFormAuth,
	handleComponentConferenceOptions,
	handleComponentNavSubjects,
	handleComponentTagOptions,
	handleComponentShareTypeOptions,
	handleComponentNavUser,
} from './routes/components';
import { handlePostPage, handleComponentPost } from './routes/post-detail';
import { handleMessageSend } from './routes/messages';
import { handleAuthStart, handleAuthCallback, handleAuthLogout, handleAuthMe } from './routes/auth';
import { handleMyPosts } from './routes/my-posts';
import {
	handleCreatePost,
	handleEditPostForm,
	handleEditPostSubmit,
	handleDeletePostConfirm,
	handleDeletePostSubmit,
} from './routes/posts';
import { handleReportForm, handleReportSubmit } from './routes/flags';

export interface RouteDefinition {
	method: string;
	/**
	 * Registered WITHOUT a trailing slash. Router.match() anchors with `$`, so
	 * `/search` and `/search/` are different strings; index.ts turns the second
	 * into a 308 to the first.
	 */
	path: string;
	handler: Handler;
}

/**
 * The single declaration of what the Worker owns.
 *
 * This lives outside index.ts so `test/assets.test.ts` can import it and check
 * the two things that used to be maintained by prose: that no Eleventy build
 * output shadows a route (that is how GET /search went silently unreachable),
 * and that every route is listed in `run_worker_first` in wrangler.toml.
 * Adding a route here is enough; forgetting the config now fails a test.
 */
export const ROUTES: RouteDefinition[] = [
	// API + HTMX component routes
	{ method: 'GET', path: '/api/featured-conferences', handler: handleFeaturedConferences },
	{ method: 'GET', path: '/api/components/create-form-auth', handler: handleComponentCreateFormAuth },
	{ method: 'GET', path: '/api/components/conference-options', handler: handleComponentConferenceOptions },
	{ method: 'GET', path: '/api/components/nav-user', handler: handleComponentNavUser },
	{ method: 'GET', path: '/api/components/nav-subjects', handler: handleComponentNavSubjects },
	{ method: 'GET', path: '/api/components/tag-options', handler: handleComponentTagOptions },
	{ method: 'GET', path: '/api/components/share-type-options', handler: handleComponentShareTypeOptions },
	{ method: 'GET', path: '/api/components/post/:id', handler: handleComponentPost },
	{ method: 'POST', path: '/api/post', handler: handleCreatePost },
	{ method: 'POST', path: '/api/message/send', handler: handleMessageSend },

	// Worker-rendered pages
	// Note the singular/plural pair: /conferences is the index, /conference/:slug
	// is one conference. They do not overlap — the wildcard that claims the
	// second in wrangler.toml is "/conference/*", which requires the slash.
	{ method: 'GET', path: '/conferences', handler: handleAllConferences },
	{ method: 'GET', path: '/conference/:slug', handler: handleConferencePage },
	{ method: 'GET', path: '/subject/:slug', handler: handleSubjectPage },
	{ method: 'GET', path: '/post/:id', handler: handlePostPage },
	{ method: 'GET', path: '/my-posts', handler: handleMyPosts },
	{ method: 'GET', path: '/search', handler: handleSearch },

	// Post ownership actions
	{ method: 'GET', path: '/post/:id/edit', handler: handleEditPostForm },
	{ method: 'POST', path: '/post/:id/edit', handler: handleEditPostSubmit },
	{ method: 'GET', path: '/post/:id/delete', handler: handleDeletePostConfirm },
	{ method: 'POST', path: '/post/:id/delete', handler: handleDeletePostSubmit },

	// Moderation
	{ method: 'GET', path: '/post/:id/report', handler: handleReportForm },
	{ method: 'POST', path: '/post/:id/report', handler: handleReportSubmit },

	// Auth routes
	{ method: 'POST', path: '/api/auth/start', handler: handleAuthStart },
	{ method: 'GET', path: '/api/auth/callback', handler: handleAuthCallback },
	{ method: 'POST', path: '/api/auth/logout', handler: handleAuthLogout },
	{ method: 'GET', path: '/api/auth/me', handler: handleAuthMe },
];

export function createRouter(): Router {
	const router = new Router();
	for (const { method, path, handler } of ROUTES) {
		router.add(method, path, handler);
	}
	return router;
}
