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

export const escapeHtml = (str: string) =>
  str.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
