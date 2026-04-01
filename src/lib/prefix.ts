export function sanitizeName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replaceAll(' ', '_')
    .replace(/[^a-z0-9_-]/g, '');

  return sanitized || '';
}
