const localOrigin = 'https://recruiting-os.invalid';

export function safeRelativeReturnTo(value: string, fallback = '/'): string {
  try {
    if (!value.startsWith('/') || value.includes('\\')) return fallback;
    const url = new URL(value, localOrigin);
    if (url.origin !== localOrigin) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

export function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}
