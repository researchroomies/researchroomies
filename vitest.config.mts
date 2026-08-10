import { defineConfig, defineProject } from 'vitest/config';
import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';

/**
 * Two projects, because the suite has two genuinely different runtimes.
 *
 * Everything that exercises Worker code runs inside workerd via
 * @cloudflare/vitest-pool-workers, which is the only way to get a real D1 and
 * real Workers globals — but workerd has no `node:fs`.
 *
 * `test/assets.test.ts` is the opposite case: it checks that the Eleventy build
 * output in public/ does not shadow a Worker route, and that wrangler.toml's
 * run_worker_first list still covers every route. Both are questions about
 * files on disk, so that file runs in plain node.
 *
 * `vitest run` with no arguments runs BOTH. A guard test that is not in the
 * default run is not a guard, so do not narrow this to one project.
 */
export default defineConfig({
	test: {
		projects: [
			defineWorkersProject({
				test: {
					name: 'workers',
					include: ['test/**/*.test.ts'],
					// The one file that must NOT run in workerd.
					exclude: ['test/assets.test.ts'],
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
					include: ['test/assets.test.ts'],
				},
			}),
		],
	},
});
