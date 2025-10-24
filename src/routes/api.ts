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
      return new Response('Conference slug is required', { status: 400 });
    }

    const conference = await getConferenceBySlug(env, slug);
    if (!conference) {
      return new Response('Conference not found', { status: 404 });
    }

    const posts = await getPostsByConferenceId(env, conference.id);
    const html = renderConferencePage(conference, posts);
    
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html',
        'Cache-Control': 'public, max-age=300' // Cache for 5 minutes
      }
    });
  } catch (error) {
    console.error('Error fetching conference:', error);
    return new Response('<p>Error loading conference. Please try again later.</p>', {
      status: 500,
      headers: { 'Content-Type': 'text/html' }
    });
  }
}
