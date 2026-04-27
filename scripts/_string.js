export function slugify(value) {
  if (!value) return '';
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

export function gedPointerToId(pointer) {
  if (!pointer) return '';
  return String(pointer).replace(/@/g, '');
}

export function displayPersonName(person) {
  const full = person?.name?.full;
  if (full) return full.replace(/\s+/g, ' ').trim();
  const parts = [person?.name?.given, person?.name?.surname].filter(Boolean);
  return parts.join(' ').trim() || 'Unknown';
}

