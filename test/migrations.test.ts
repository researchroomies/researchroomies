import { describe, it, expect, beforeEach } from 'vitest';
import { resetDatabase, testEnv } from './helpers/seed';
import { listTags } from '../src/db/tags';
import { listShareTypes } from '../src/db/share-types';

/**
 * What the migration chain leaves behind.
 *
 * The curated lists are the part of this database that drifted: `tags` was
 * seeded by an edited-and-re-run `INSERT OR IGNORE`, which changes new databases
 * and silently does nothing to existing ones, so production served five short
 * STEM-only slugs while the file in git described twelve long ones and nobody
 * found out until a subject filter returned nothing.
 *
 * These tests are the thing that was missing: they run the real migrations (the
 * seed helper applies migrations/*.sql in order) and assert the end state
 * exactly. A migration that half-renames, or a thirteenth subject added by
 * editing 0002 instead of writing 0004, fails here.
 */

beforeEach(async () => {
	await resetDatabase();
});

describe('0002 settles the subject slugs', () => {
	it('leaves exactly the twelve canonical subjects', async () => {
		const slugs = (await listTags(testEnv)).map((tag) => tag.slug).sort();

		expect(slugs).toEqual([
			'biology',
			'chemistry',
			'computer-science',
			'earth-science',
			'economics',
			'education',
			'engineering',
			'humanities',
			'mathematics',
			'medicine',
			'physics',
			'social-sciences',
		]);
	});

	it('retires every short slug rather than leaving a duplicate list', async () => {
		// The failure mode the old seed produced on production: `bio` and
		// `biology` both present, so the nav lists Biology twice.
		const slugs = new Set((await listTags(testEnv)).map((tag) => tag.slug));

		for (const retired of ['bio', 'chem', 'cs', 'math']) {
			expect(slugs.has(retired), `${retired} should have been renamed away`).toBe(false);
		}
	});

	it('gives every subject a display name', async () => {
		// The upsert exists to make names converge too — production's stored
		// names were never in version control, so an IGNORE would have left them.
		for (const tag of await listTags(testEnv)) {
			expect(tag.name, `${tag.slug} has no name`).toBeTruthy();
		}
	});

	it('covers subjects outside STEM', async () => {
		// The reason the twelve won over the five: a cost-sharing site for
		// academics that cannot list humanities or social sciences excludes the
		// fields with the thinnest travel budgets.
		const slugs = new Set((await listTags(testEnv)).map((tag) => tag.slug));

		expect(slugs.has('humanities')).toBe(true);
		expect(slugs.has('social-sciences')).toBe(true);
		expect(slugs.has('education')).toBe(true);
	});
});

describe('0003 seeds the share types', () => {
	it('leaves the five types in curated order', async () => {
		const types = await listShareTypes(testEnv);

		expect(types.map((type) => type.slug)).toEqual(['lodging', 'carpool', 'rental-car', 'airport-transfer', 'other']);
		expect(types.at(-1)?.name).toBe('Other');
	});
});
