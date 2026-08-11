import { defineConfig, defineProject } from 'vitest/config';
import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

/**
 * Two projects, because the suite has two genuinely different runtimes.
 *
 * Everything that exercises Worker code runs inside workerd via
 * @cloudflare/vitest-pool-workers, which is the only way to get a real D1 and
 * real Workers globals — but workerd has no `node:fs`.
 *
 * The files in NODE_ONLY are the opposite case — they read source and build
 * output off disk rather than executing any of it:
 *
 *   test/assets.test.ts        no Eleventy output shadows a Worker route, and
 *                              run_worker_first still covers every route
 *   test/session-access.test.ts  session resolution goes through lib/guards.ts,
 *                              ownership is not re-checked by hand, and only
 *                              lib/turnstile.ts talks to siteverify
 *
 * `vitest run` with no arguments runs BOTH projects. A guard test that is not in
 * the default run is not a guard, so do not narrow this to one project.
 */
const NODE_ONLY = ['test/assets.test.ts', 'test/session-access.test.ts'];
export default defineConfig({
	test: {
		projects: [
			defineWorkersProject({
				test: {
					name: 'workers',
					include: ['test/**/*.test.ts'],
					// The files that must NOT run in workerd.
					exclude: NODE_ONLY,
					poolOptions: {
						workers: {
							wrangler: { configPath: './wrangler.toml' },
						},
					},
				},
			}),
			defineProject({
				test: {
					name: 'node',
					environment: 'node',
					include: NODE_ONLY,
				},
			}),
		],
	},
});
