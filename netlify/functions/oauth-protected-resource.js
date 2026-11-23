// netlify/functions/oauth-protected-resource.js
// OAuth 2.0 Protected Resource Metadata (RFC 9728) for the /mcp connector.
// Tells MCP clients (the Claude app) which authorization server issues tokens for CardDesk:
// Supabase Auth's OAuth 2.1 server for this project.
export default async (req) => {
  const origin = new URL(req.url).origin;
  const supabase = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
  return new Response(JSON.stringify({
    resource: `${origin}/mcp`,
    authorization_servers: [`${supabase}/auth/v1`],
    bearer_methods_supported: ['header'],
    resource_name: 'CardDesk',
    resource_documentation: `${origin}/?tab=snap`,
  }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } });
};

export const config = { path: ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'] };
