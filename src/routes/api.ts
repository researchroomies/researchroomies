interface Conference {
  id: number;
  name: string;
  slug: string;
  location_address: string;
  start_time: number;
  stop_time: number;
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
