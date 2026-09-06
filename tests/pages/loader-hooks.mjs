// Node module-resolution hook used by run.mjs. Each page load imports its
// module with a unique `?run=N` query; this hook propagates that query to
// every relative import beneath it (api.js, ui.js, ...) so each page gets a
// fresh module graph and a fresh Supabase client instead of the cached one.
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  const parentQuery = context.parentURL?.split('?')[1];
  if (parentQuery && result.url.startsWith('file:') && !result.url.includes('?') && !result.url.includes('/node_modules/')) {
    return { ...result, url: `${result.url}?${parentQuery}` };
  }
  return result;
}
