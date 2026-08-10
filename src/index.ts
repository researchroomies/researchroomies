import { Router } from './lib/router';
import {
	handleFeaturedConferences,
	handleConferencePage,
	handleComponentCreateFormAuth,
	handleComponentConferenceOptions,
	handleComponentNavSubjects,
	handleComponentTagOptions,
	handleCreatePost,
	handlePostShell,
	handleComponentPost,
	handleComponentNavUser,
	handleMessageSend,
	handleMyPosts,
	handleSearch,
	handleSubjectPage,
} from './routes/api';
import { handleAuthStart, handleAuthCallback, handleAuthLogout, handleAuthMe } from './routes/auth';
import { handleEditPostForm, handleEditPostSubmit, handleDeletePostConfirm, handleDeletePostSubmit } from './routes/posts';
import { handleReportForm, handleReportSubmit } from './routes/flags';

const router = new Router();

// API + HTMX component routes
router.add('GET', '/api/featured-conferences', handleFeaturedConferences);
router.add('GET', '/api/components/create-form-auth', handleComponentCreateFormAuth);
router.add('GET', '/api/components/conference-options', handleComponentConferenceOptions);
router.add('GET', '/api/components/nav-user', handleComponentNavUser);
router.add('GET', '/api/components/nav-subjects', handleComponentNavSubjects);
router.add('GET', '/api/components/tag-options', handleComponentTagOptions);
router.add('GET', '/api/components/post/:id', handleComponentPost);
router.add('POST', '/api/post', handleCreatePost);
router.add('POST', '/api/message/send', handleMessageSend);

// Worker-rendered pages
router.add('GET', '/conference/:slug', handleConferencePage);
router.add('GET', '/subject/:slug', handleSubjectPage);
router.add('GET', '/post/:id', handlePostShell);
router.add('GET', '/my-posts', handleMyPosts);
router.add('GET', '/search', handleSearch);

// Post ownership actions
router.add('GET', '/post/:id/edit', handleEditPostForm);
router.add('POST', '/post/:id/edit', handleEditPostSubmit);
router.add('GET', '/post/:id/delete', handleDeletePostConfirm);
router.add('POST', '/post/:id/delete', handleDeletePostSubmit);

// Moderation
router.add('GET', '/post/:id/report', handleReportForm);
router.add('POST', '/post/:id/report', handleReportSubmit);

// Auth routes
router.add('POST', '/api/auth/start', handleAuthStart);
router.add('GET', '/api/auth/callback', handleAuthCallback);
router.add('POST', '/api/auth/logout', handleAuthLogout);
router.add('GET', '/api/auth/me', handleAuthMe);

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		// Ask the router itself whether it owns this path. Previously this was a
		// hand-maintained path-prefix regex that every new route had to be added
		// to by hand — forgetting to was a silent 404.
		const matched = router.match(request.method, url.pathname);
		if (matched) {
			return await matched.route.handler(request, env, ctx, matched.params);
		}

		// Worker routes are registered without a trailing slash, so /search/ used
		// to fall straight through to the 404 page. That URL is not hypothetical:
		// Eleventy emitted directory-style pages, so /search/ is where the old
		// static search page lived, and it survives in bookmarks, browser history
		// and URL autocomplete. Redirect rather than match silently, so those
		// stale entries heal and each route keeps one canonical URL.
		//
		// Only redirect when trimming actually reveals a Worker route: real assets
		// ARE directory-style (/about/, /login/), and those must be left alone.
		if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
			const trimmed = url.pathname.replace(/\/+$/, '');
			if (trimmed && router.match(request.method, trimmed)) {
				const target = new URL(url);
				target.pathname = trimmed;
				// 308 rather than 301: it preserves the method, so POST routes such
				// as /post/:id/edit/ do not silently degrade into a GET.
				return Response.redirect(target.href, 308);
			}
		}

		// Anything else is a static asset built by Eleventy into public/.
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
