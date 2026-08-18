import { sessionUserId } from "../lib/session";
import { requireUser } from "../lib/guards";
import { verifyTurnstile } from "../lib/turnstile";
import { parseRouteId } from "../lib/params";
import { createPost } from "../db/posts";
import { createConference, reserveSlug } from "../db/conferences";
import { tagConference } from "../db/tags";
import { setShareTypesForPost } from "../db/share-types";
import { submittedShareTypes } from "../lib/share-types";
import { readAuthorFields } from "../lib/positions";

/**
 * Creating a post — the one handler that writes across four tables.
 *
 * Split from posts.ts when the position and institution fields took that file
 * past the route-module size bound. The seam is `requireOwnedPost()`: edit and
 * delete each begin from a post that exists and belongs to the caller, whereas
 * this begins from a session and may write a conference, its subject tags, the
 * post and its share types before it returns. The two halves share no code and
 * no rendering — what they have in common (the position fields, the share-type
 * slugs) already lives in src/lib/, which is what a route module is allowed to
 * import.
 *
 * The order of the checks in here is load-bearing, and each one is commented at
 * the point it matters.
 */

export async function handleCreatePost(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const guard = await requireUser(request, env, "api");
  if (!guard.ok) return guard.response;
  const user = guard.value;

  try {
    const formData = await request.formData();
    let conferenceId = formData.get("conference_id") as string;
    const title = formData.get("title") as string;
    const description = formData.get("description") as string;

    if (!title || !description || !conferenceId) {
      return new Response("Missing required fields", { status: 400 });
    }

    const turnstileOk = await verifyTurnstile(
      formData.get("cf-turnstile-response") as string | null,
      request,
      env,
    );
    if (!turnstileOk) {
      return new Response(
        "Could not verify that you are human. Please reload the page and try again.",
        { status: 400 },
      );
    }

    // After Turnstile, because it reads the database and an unverified request
    // should not get that far — and before the conference branch below, because
    // that branch writes a conference and rejecting the post afterwards would
    // leave the orphan the known non-atomicity note describes, one that has
    // already taken its slug.
    const author = await readAuthorFields(env, formData);
    if (!author.ok) return author.response;

    const now = Math.floor(Date.now() / 1000);
    const userId = sessionUserId(user);

    // KNOWN LIMIT: creating a post against a new conference is three separate
    // writes (conference insert, tag batch, post insert) with no transaction
    // around them. If the post insert fails, the conference survives as an
    // orphan and keeps its slug, so the user's retry gets "-2" appended.
    // The reason D1 cannot fix this is recorded on src/db/conferences.ts.
    if (conferenceId === "new") {
      const newConfName = formData.get("new_conf_name") as string;
      const newConfStartStr = formData.get("new_conf_start") as string;
      const newConfEndStr = formData.get("new_conf_end") as string;
      const newConfCity = formData.get("new_conf_city") as string;
      const newConfState = formData.get("new_conf_state") as string;
      const newConfLocation = [newConfCity, newConfState]
        .filter(Boolean)
        .join(", ");

      if (!newConfName || !newConfStartStr || !newConfEndStr) {
        return new Response("Missing required fields for new conference", {
          status: 400,
        });
      }

      const slug = await reserveSlug(env, newConfName);
      const startTime = Math.floor(new Date(newConfStartStr).getTime() / 1000);
      const stopTime = Math.floor(new Date(newConfEndStr).getTime() / 1000);

      if (!Number.isFinite(startTime) || !Number.isFinite(stopTime)) {
        return new Response("Invalid conference dates", { status: 400 });
      }

      const newConferenceId = await createConference(env, {
        userId,
        name: newConfName,
        slug,
        locationAddress: newConfLocation || null,
        startTime,
        stopTime,
        createdAt: now,
      });
      conferenceId = newConferenceId.toString();

      // Subjects are conference-level. tagConference() drops any slug that is
      // not already in `tags`, which is what keeps the curated list curated.
      const submittedTags = formData
        .getAll("conf_tags")
        .map((value) => String(value).trim())
        .filter(Boolean);

      await tagConference(env, newConferenceId, submittedTags);
    }

    const parsedConferenceId = parseRouteId(conferenceId);
    if (parsedConferenceId === null) {
      return new Response("Invalid conference", { status: 400 });
    }

    const postId = await createPost(env, {
      userId,
      conferenceId: parsedConferenceId,
      title,
      description,
      createdAt: now,
      position: author.position,
      institution: author.institution,
    });

    // Share types are post-level and optional. setShareTypesForPost() drops any
    // slug outside the curated list, and writes nothing when none were checked.
    await setShareTypesForPost(env, postId, submittedShareTypes(formData));

    return Response.redirect(`${new URL(request.url).origin}/my-posts`, 303);
  } catch (err) {
    console.error("Error creating post:", err);
    return new Response("Internal Server Error", { status: 500 });
  }
}
