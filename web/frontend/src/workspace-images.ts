export async function fetchWorkspaceImage(
  path: string, server: string, token: string, signal: AbortSignal,
): Promise<Blob> {
  const headers = new Headers({ 'x-orbitd-url': server });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const query = new URLSearchParams({ path });
  const response = await fetch(`/api/v1/fs/raw?${query}`, { headers, signal });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
    throw new Error('Image unavailable');
  }
  return response.blob();
}

export function workspaceImagePath(href: string, cwd: string): string | undefined {
  const reference = href.trim().replace(/^sandbox:(?=\/mnt\/data\/)/i, '');
  if (!reference || reference.startsWith('//') || reference.startsWith('#') ||
      reference.includes('\\') || /^[a-z][a-z\d+.-]*:/i.test(reference)) return;
  if (!reference.startsWith('/') && !cwd.startsWith('/')) return;
  try {
    const origin = 'https://orbit-files.invalid';
    const directory = cwd.replace(/\/+$/, '').split('/').map(encodeURIComponent).join('/');
    const url = new URL(reference, new URL(`${directory}/`, origin));
    if (url.origin !== origin) return;
    const path = decodeURIComponent(url.pathname);
    if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|tiff?)$/i.test(path)) return path;
  } catch {
    // Malformed references remain plain text in the conversation.
  }
}
