// Person-display helpers shared by every initials avatar (user list, research
// author chip, …). The app has no avatar image URLs — identity is a two-letter
// monogram on a deterministic tint, so the same person keeps the same color
// everywhere.

/** Two-letter initials from a name (falls back to the email's first char). */
export function initials(name: string, email: string) {
  const [first, last] = name.trim().split(/\s+/);
  if (first) return (last ? `${first[0]}${last[0]}` : first.slice(0, 2)).toUpperCase();
  return (email[0] ?? 'U').toUpperCase();
}

// Deterministic avatar tint from the id so each person keeps a stable color.
const avatarTints = [
  'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300',
  'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
  'bg-amber-500/15 text-amber-600 dark:text-amber-300',
  'bg-rose-500/15 text-rose-600 dark:text-rose-300',
  'bg-sky-500/15 text-sky-600 dark:text-sky-300',
  'bg-violet-500/15 text-violet-600 dark:text-violet-300',
];

/** A stable tailwind tint class for a person, hashed from their id. */
export function tintFor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return avatarTints[h % avatarTints.length];
}
