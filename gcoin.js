import dashboard from './index.html';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if ((url.pathname === '/' || url.pathname === '/index.html') &&
        (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(request.method === 'HEAD' ? null : dashboard, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
      });
    }
    return env.CORE.fetch(request);
  },
};
