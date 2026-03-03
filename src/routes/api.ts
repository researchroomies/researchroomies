import nunjucks from 'nunjucks';
import baseTemplate from '../../templates/layouts/base.njk';
import { verifySessionToken } from '../lib/auth';
import { sendInquiryEmail } from '../lib/mailgun';

const nunjucksEnv = new nunjucks.Environment(null as any, { autoescape: true });

interface Conference {
  id: number;
  name: string;
  slug: string;
  location_address: string;
  start_time: number;
  stop_time: number;
  description?: string;
}

interface Post {
  id: number;
  title: string;
  description: string;
  created_at: number;
}

async function getFeaturedConferences(env: Env): Promise<Conference[]> {
  const stmt = env.DB.prepare(`
    SELECT id, name, slug, location_address, start_time, stop_time
    FROM conferences 
    WHERE is_featured = 1 
    ORDER BY created_at DESC 
    LIMIT 10
  `);

  const result = await stmt.all();
  return result.results as unknown as Conference[];
}

async function getConferenceBySlug(env: Env, slug: string): Promise<Conference | null> {
  const stmt = env.DB.prepare(`
    SELECT id, name, slug, location_address, start_time, stop_time, description
    FROM conferences 
    WHERE slug = ?
  `);

  const result = await stmt.bind(slug).first();
  return result as unknown as Conference | null;
}

async function getPostsByConferenceId(env: Env, conferenceId: number): Promise<Post[]> {
  const stmt = env.DB.prepare(`
    SELECT id, title, description, created_at
    FROM posts 
    WHERE conference_id = ?
    ORDER BY created_at DESC
  `);

  const result = await stmt.bind(conferenceId).all();
  return result.results as unknown as Post[];
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function renderFeaturedConferences(conferences: Conference[]): string {
  if (conferences.length === 0) {
    return '<p>No featured conferences available at the moment.</p>';
  }

  const items = conferences.map(conf => `
    <li>
      <a href="/conference/${conf.slug}">
        <strong>${conf.name}</strong><br />
        ${conf.location_address} (${formatDate(conf.start_time)} - ${formatDate(conf.stop_time)})
      </a>
    </li>
  `).join('');

  return `<ul>${items}</ul>`;
}

function renderConferencePage(conference: Conference, posts: Post[]): string {
  const postsHtml = posts.length > 0
    ? posts.map(post => `<li><a href="/post/${post.id}">${post.title}</a></li>`).join('')
    : '<li>No posts available for this conference.</li>';

  return `
    <h2>${conference.name}</h2>
    <p>${conference.description || 'No description available.'}</p>
    <ul>
      ${postsHtml}
    </ul>
  `;
}

function renderFullPage(title: string, content: string): string {
  return nunjucksEnv.renderString(baseTemplate, {
    page_title: title,
    page_content: content,
    year: new Date().getFullYear(),
  });
}

export async function handleFeaturedConferences(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const conferences = await getFeaturedConferences(env);
    const html = renderFeaturedConferences(conferences);

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html',
        'Cache-Control': 'public, max-age=300' // Cache for 5 minutes
      }
    });
  } catch (error) {
    console.error('Error fetching featured conferences:', error);
    return new Response('<p>Error loading featured conferences. Please try again later.</p>', {
      status: 500,
      headers: { 'Content-Type': 'text/html' }
    });
  }
}

export async function handleConferencePage(request: Request, env: Env, ctx: ExecutionContext, params?: Record<string, string>): Promise<Response> {
  try {
    const slug = params?.slug;
    if (!slug) {
      return new Response(renderFullPage('Error', '<h2>Error</h2><p>Conference slug is required</p>'), {
        status: 400,
        headers: { 'Content-Type': 'text/html' }
      });
    }

    const conference = await getConferenceBySlug(env, slug);
    if (!conference) {
      return new Response(renderFullPage('Conference Not Found', '<h2>Conference Not Found</h2><p>The requested conference could not be found.</p>'), {
        status: 404,
        headers: { 'Content-Type': 'text/html' }
      });
    }

    const posts = await getPostsByConferenceId(env, conference.id);
    const content = renderConferencePage(conference, posts);
    const fullHtml = renderFullPage(conference.name, content);

    return new Response(fullHtml, {
      headers: {
        'Content-Type': 'text/html',
        'Cache-Control': 'public, max-age=300' // Cache for 5 minutes
      }
    });
  } catch (error) {
    console.error('Error fetching conference:', error);
    return new Response(renderFullPage('Error', '<h2>Error</h2><p>Error loading conference. Please try again later.</p>'), {
      status: 500,
      headers: { 'Content-Type': 'text/html' }
    });
  }
}

async function getAllConferences(env: Env): Promise<Conference[]> {
  const stmt = env.DB.prepare(`
    SELECT id, name
    FROM conferences 
    ORDER BY name ASC
  `);

  const result = await stmt.all();
  return result.results as unknown as Conference[];
}

export async function handleComponentCreateFormAuth(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cookieHeader = request.headers.get('Cookie');
  let user = null;
  if (cookieHeader) {
    const cookies = Object.fromEntries(cookieHeader.split(';').map(c => c.trim().split('=')));
    const token = cookies['rr_session'];
    if (token) {
      user = await verifySessionToken(token, env.AUTH_HMAC_SECRET);
    }
  }

  if (!user) {
    return new Response('', {
      status: 200,
      headers: { 'HX-Redirect': '/login' }
    });
  }

  const html = `<div id="auth-email-container"><label>Email</label><input type="email" name="email" value="${user.email}" readonly /></div>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html' }
  });
}

export async function handleComponentConferenceOptions(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const conferences = await getAllConferences(env);
    const optionsHtml = conferences.map(conf => `<option value="${conf.id}">${conf.name}</option>`).join('');
    const html = optionsHtml + '<option value="new">Create New Conference</option>';

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html',
        'Cache-Control': 'public, max-age=300'
      }
    });
  } catch (error) {
    console.error('Error fetching conferences:', error);
    return new Response('<option value="new">Error loading conferences. Create New Conference.</option>', {
      status: 500,
      headers: { 'Content-Type': 'text/html' }
    });
  }
}

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

export async function handleCreatePost(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const cookieHeader = request.headers.get('Cookie');
  let user = null;
  if (cookieHeader) {
    const cookies = Object.fromEntries(cookieHeader.split(';').map(c => c.trim().split('=')));
    const token = cookies['rr_session'];
    if (token) {
      user = await verifySessionToken(token, env.AUTH_HMAC_SECRET);
    }
  }

  if (!user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const formData = await request.formData();
    let conferenceId = formData.get('conference_id') as string;
    const title = formData.get('title') as string;
    const description = formData.get('description') as string;
    const cf_turnstile_response = formData.get('cf-turnstile-response') as string;

    if (!title || !description || !conferenceId) {
      return new Response('Missing required fields', { status: 400 });
    }

    if (cf_turnstile_response) {
      const turnstileBody = new FormData();
      turnstileBody.append('secret', env.TURNSTILE_SECRET_KEY);
      turnstileBody.append('response', cf_turnstile_response);
      turnstileBody.append('remoteip', request.headers.get('CF-Connecting-IP') || '');

      const turnVerify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: turnstileBody,
      });

      const turnResult = await turnVerify.json() as any;
      if (!turnResult.success) {
        console.error("Turnstile failed:", turnResult);
        return new Response('Invalid Turnstile', { status: 400 });
      }
    }

    const now = Math.floor(Date.now() / 1000);

    // Resolve user ID
    let userId: number;
    const userRow = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(user.email).first<{ id: number }>();
    if (!userRow) {
      return new Response('User not found in database', { status: 404 });
    }
    userId = userRow.id;

    if (conferenceId === 'new') {
      const newConfName = formData.get('new_conf_name') as string;
      const newConfStartStr = formData.get('new_conf_start') as string;
      const newConfEndStr = formData.get('new_conf_end') as string;
      const newConfLocation = formData.get('new_conf_location') as string;

      if (!newConfName || !newConfStartStr || !newConfEndStr) {
        return new Response('Missing required fields for new conference', { status: 400 });
      }

      const slug = generateSlug(newConfName);
      const startTime = Math.floor(new Date(newConfStartStr).getTime() / 1000);
      const stopTime = Math.floor(new Date(newConfEndStr).getTime() / 1000);

      const result = await env.DB.prepare(`
        INSERT INTO conferences (user_id, name, slug, location_address, start_time, stop_time, created_at, is_featured)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        RETURNING id
      `).bind(userId, newConfName, slug, newConfLocation || null, startTime, stopTime, now).first<{ id: number }>();

      if (!result) {
        throw new Error('Failed to create conference');
      }
      conferenceId = result.id.toString();
    }

    const parsedConferenceId = parseInt(conferenceId, 10);

    const result = await env.DB.prepare(`
      INSERT INTO posts (user_id, conference_id, title, description, created_at)
      VALUES (?, ?, ?, ?, ?)
      RETURNING id
    `).bind(userId, parsedConferenceId, title, description, now).first<{ id: number }>();

    if (!result) {
      throw new Error('Failed to create post');
    }

    return Response.redirect(`${new URL(request.url).origin}/`, 303);
  } catch (err: any) {
    console.error('Error creating post:', err);
    return new Response('Internal Server Error: ' + err.message, { status: 500 });
  }
}

export async function handleMessageSend(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const cookieHeader = request.headers.get('Cookie');
  let user = null;
  if (cookieHeader) {
    const cookies = Object.fromEntries(cookieHeader.split(';').map(c => c.trim().split('=')));
    const token = cookies['rr_session'];
    if (token) {
      user = await verifySessionToken(token, env.AUTH_HMAC_SECRET);
    }
  }

  if (!user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const formData = await request.formData();
    const postId = formData.get('post_id') as string;
    const content = formData.get('content') as string;
    const cf_turnstile_response = formData.get('cf-turnstile-response') as string;

    if (!postId || !content) {
      return new Response('Missing required fields', { status: 400 });
    }

    if (cf_turnstile_response) {
      const turnstileBody = new FormData();
      turnstileBody.append('secret', env.TURNSTILE_SECRET_KEY);
      turnstileBody.append('response', cf_turnstile_response);
      turnstileBody.append('remoteip', request.headers.get('CF-Connecting-IP') || '');

      const turnVerify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: turnstileBody,
      });

      const turnResult = await turnVerify.json() as any;
      if (!turnResult.success) {
        console.error("Turnstile failed:", turnResult);
        return new Response('Invalid Turnstile', { status: 400 });
      }
    }

    const stmt = env.DB.prepare(`
      SELECT u.email, p.title
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE p.id = ?
    `);

    const result = await stmt.bind(parseInt(postId, 10)).first<{ email: string, title: string }>();

    if (!result) {
      return new Response('Post not found', { status: 404 });
    }

    const success = await sendInquiryEmail(result.email, user.email, result.title, content, env);

    if (!success) {
      throw new Error('Failed to send email');
    }

    return Response.redirect(`${new URL(request.url).origin}/post/${postId}`, 303);
  } catch (error) {
    console.error('Error sending message:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

export async function handlePostShell(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Fetch static `/post/index.html` from Cloudflare Pages Assets
  const assetUrl = new URL('/post/', request.url);
  const assetRequest = new Request(assetUrl, request);
  return env.ASSETS.fetch(assetRequest);
}

export async function handleComponentPost(request: Request, env: Env, ctx: ExecutionContext, params?: Record<string, string>): Promise<Response> {
  const postId = params?.id;
  if (!postId) {
    return new Response('Missing post ID', { status: 400 });
  }

  try {
    const stmt = env.DB.prepare(`
      SELECT p.id, p.title, p.description, p.conference_id, c.name as conference_name, c.slug as conference_slug
      FROM posts p
      JOIN conferences c ON p.conference_id = c.id
      WHERE p.id = ?
    `);

    const result = await stmt.bind(parseInt(postId, 10)).first<{
      id: number;
      title: string;
      description: string;
      conference_id: number;
      conference_name: string;
      conference_slug: string;
    }>();

    if (!result) {
      return new Response('<p>Post not found.</p>', { status: 404, headers: { 'Content-Type': 'text/html' } });
    }

    const cookieHeader = request.headers.get('Cookie');
    let user = null;
    if (cookieHeader) {
      const cookies = Object.fromEntries(cookieHeader.split(';').map(c => c.trim().split('=')));
      const token = cookies['rr_session'];
      if (token) {
        user = await verifySessionToken(token, env.AUTH_HMAC_SECRET);
      }
    }

    const formHtml = user ? `
        <form action="/api/message/send" method="POST">
          <input type="hidden" name="post_id" value="${result.id}" />
          <label>Message</label>
          <textarea name="content" rows="5" required></textarea>
          <div class="cf-turnstile" data-sitekey="0x4AAAAAAByAHmDummOs9UGm"></div>
          <button type="submit">Send</button>
        </form>
    ` : `
        <p>Please <a href="/login">log in</a> to send an inquiry.</p>
    `;

    const html = `
      <article>
        <h2>${result.title}</h2>
        <p>${result.description}</p>
        <p><strong>Conference:</strong> <a href="/conference/${result.conference_slug}">${result.conference_name}</a></p>
      </article>
      <section>
        <h3>Send an Inquiry</h3>
        ${formHtml}
      </section>
    `;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=60' }
    });

  } catch (error) {
    console.error('Error fetching post:', error);
    return new Response('<p>Error loading post.</p>', { status: 500, headers: { 'Content-Type': 'text/html' } });
  }
}

export async function handleComponentNavUser(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cookieHeader = request.headers.get('Cookie');
  let user = null;
  if (cookieHeader) {
    const cookies = Object.fromEntries(cookieHeader.split(';').map(c => c.trim().split('=')));
    const token = cookies['rr_session'];
    if (token) {
      user = await verifySessionToken(token, env.AUTH_HMAC_SECRET);
    }
  }

  const html = user
    ? `<a href="#" hx-post="/api/auth/logout" class="nav-link">Logout</a>`
    : `<a href="/login" class="nav-link">Login</a>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html', 'Cache-Control': 'private, no-cache' }
  });
}
