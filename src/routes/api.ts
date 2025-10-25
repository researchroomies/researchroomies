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
  const currentYear = new Date().getFullYear();
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} – ResearchRoomies</title>
  <link rel="stylesheet" href="/style/style.css" />
  <script src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.7/dist/htmx.min.js" integrity="sha384-ZBXiYtYQ6hJ2Y0ZNoYuI+Nq5MqWBr+chMrS/RkXpNzQCApHEhOt2aY8EJgqwHLkJ" crossorigin="anonymous"></script>
</head>
<body>
  <header>
    <div class="logo-nav">
      <h1><a href="/">ResearchRoomies</a></h1>
      <nav>
        <a href="/search" class="nav-link">Search</a>
        <a href="/create" class="nav-link">Create Post</a>
      </nav>
    </div>
  </header>

  <main>
    ${content}
  </main>

  <footer>
    <div class="fat-footer">
      <p>&copy; ${currentYear} ResearchRoomies. All rights reserved.</p>
      <a href="/about">About</a> | <a href="/terms">Terms</a> | <a href="/privacy">Privacy</a>
    </div>
  </footer>
</body>
</html>`;
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
