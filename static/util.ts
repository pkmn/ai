import * as path from 'path';

export const ROOT = path.basename(path.dirname(__dirname)) === 'build'
  ? path.join(__dirname, '..', '..')
  : path.join(__dirname, '..');

export const root = (...paths: string[]) => path.join(ROOT, ...paths);

export const slugify = (s: string) =>
  s.replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '')
    .replace(/--+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

export const toID = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '');

// Version labels are capped at 12 characters and must start with an ASCII alphanumeric character
// (preventing `.` / `..` path traversal segments when mounting version directories on the runner).
export const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,11}$/;

const PS_ZALGO_RE = new RegExp(
  '[\\u0300-\\u036f\\u0483-\\u0489\\u0610-\\u0615\\u064B-\\u065F\\u0670\\u06D6-\\u06DC' +
  '\\u06DF-\\u06ED\\u0E31\\u0E34-\\u0E3A\\u0E47-\\u0E4E]{3,}|[\\u239b-\\u23b9]'
);
const PS_LEADING_RANK_RE = /^[~&@%+*!#/\-§]/;

function hasControlOrBidiChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (
      c <= 0x1f ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0x200e ||
      c === 0x200f ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

// Validates that an Arena agent display name conforms to Pokémon Showdown username conventions
// (`Dex.getName` + `Users.NameValidator`): 1..18 characters, protocol-safe (`|`, `[`, `]`, `,`
// forbidden), no consecutive/non-ASCII whitespace or control/bidi/zalgo characters, no leading
// rank/command prefix, and a non-`guest` `toID` containing at least one ASCII letter.
export function validateAgentName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > 18) {
    throw new Error(`Agent name "${raw}" must be 1–18 characters`);
  }
  if (
    /[|[\],]/.test(name) ||
    /\s{2,}/.test(name) ||
    /[^\S ]/.test(name) ||
    hasControlOrBidiChar(name) ||
    PS_ZALGO_RE.test(name)
  ) {
    throw new Error(
      `Agent name "${name}" contains disallowed Pokémon Showdown username characters`
    );
  }
  if (PS_LEADING_RANK_RE.test(name)) {
    throw new Error(
      `Agent name "${name}" cannot start with a Pokémon Showdown rank or command symbol`
    );
  }
  const id = toID(name);
  if (!id || id.length > 18 || !/[a-z]/.test(id)) {
    throw new Error(`Agent name "${name}" must contain at least one ASCII letter`);
  }
  if (id.startsWith('guest')) {
    throw new Error(`Agent name "${name}" cannot use reserved Pokémon Showdown "Guest" prefix`);
  }
  return name;
}

export function validateVersion(raw: string): string {
  const version = raw.trim();
  if (!VERSION_RE.test(version)) {
    throw new Error(
      `Version "${raw}" must be 1–12 characters matching ^[A-Za-z0-9][A-Za-z0-9._-]{0,11}$`
    );
  }
  return version;
}

export const escapeHtml = (str: string) =>
  str.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const renderTemplate = (
  template: string,
  vars: Record<string, string | number | undefined>
) =>
  template
    .replace(/\{\{\{(\w+)\}\}\}/g, (_, k: string) => String(vars[k] ?? ''))
    .replace(/\{\{(\w+)\}\}/g, (_, k: string) => escapeHtml(String(vars[k] ?? '')));

export function formatUtcDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export function formatUtcDateTime(epochSeconds: number): string {
  const iso = new Date(epochSeconds * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
