/** @license MIT modified from Vadim Demedes's https://github.com/vadimdemedes/dom-chef */

export class Html {
  readonly html: string;

  constructor(html: string) {
    this.html = html;
  }

  toString() {
    return this.html;
  }
}

export type Child = Html | string | number | boolean | undefined | Child[];

export type Component<P = any> = (props: P) => Html;

declare global {
  function h(
    type: Component | string,
    attributes?: Record<string, unknown>,
    ...children: Child[]
  ): Html;
  function Fragment(props?: {
    children?: Child;
    dangerouslySetInnerHTML?: {__html: string};
  }): Html;

  namespace JSX {
    type Element = Html;
    interface IntrinsicElements {
      [elemName: string]: Record<string, unknown>;
    }
  }
}

export const escapeHtml = (str: string) =>
  str.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const raw = (html: string) => new Html(html);

// https://github.com/preactjs/preact/blob/1bbd687c/src/constants.js#L3
const IS_NON_DIMENSIONAL = /acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i;

// https://github.com/facebook/react/blob/3f899089/packages/react-dom/src/shared/DOMProperty.js#L288-L322
const FALSIFIABLE_ATTRIBUTES = new Set(['contenteditable', 'draggable', 'spellcheck', 'value']);

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img',
  'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// `site`'s `html-minifier` runs with `removeEmptyElements: true` and strips childless non-HTML-void
// tags (`<polygon ...></polygon>`) unless emitted with a self-closing `/>` unary slash.
const SVG_SELF_CLOSING_ELEMENTS = new Set([
  'circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'rect', 'stop', 'use',
]);

const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);

const ATTR_NAMES: Record<string, string> = {
  htmlFor: 'for',
  className: 'class',
  tabIndex: 'tabindex',
  colSpan: 'colspan',
  rowSpan: 'rowspan',
  maxLength: 'maxlength',
  minLength: 'minlength',
  readOnly: 'readonly',
  autoComplete: 'autocomplete',
  autoFocus: 'autofocus',
  spellCheck: 'spellcheck',
  contentEditable: 'contenteditable',
  httpEquiv: 'http-equiv',
  strokeWidth: 'stroke-width',
  strokeOpacity: 'stroke-opacity',
  strokeDasharray: 'stroke-dasharray',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  fillOpacity: 'fill-opacity',
  textAnchor: 'text-anchor',
  fontSize: 'font-size',
  fontWeight: 'font-weight',
};

const formatStyle = (
  style: Record<string, string | number | boolean | undefined> | string
): string => {
  if (typeof style === 'string') return style;
  const parts: string[] = [];
  for (const [name, value] of Object.entries(style)) {
    if (value === undefined || value === false || value === '') continue;
    const prop = name.startsWith('-')
      ? name
      : name.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
    const val = typeof value === 'number' && !IS_NON_DIMENSIONAL.test(name)
      ? `${value}px`
      : String(value);
    parts.push(`${prop}:${val}`);
  }
  return parts.join(';');
};

const renderChildren = (children: Child[], rawText = false): string => {
  let out = '';
  for (const child of children) {
    if (child instanceof Html) {
      out += child.html;
    } else if (Array.isArray(child)) {
      out += renderChildren(child, rawText);
    } else if (typeof child !== 'boolean' && child !== undefined) {
      const str = String(child);
      out += rawText ? str : escapeHtml(str);
    }
  }
  return out;
};

export function h(
  type: Component | string,
  attributes?: Record<string, unknown>,
  ...children: Child[]
): Html {
  if (typeof type !== 'string') {
    const props = children.length ? {...attributes, children} : (attributes ?? {});
    return type(props);
  }

  let inner = renderChildren(children, RAW_TEXT_ELEMENTS.has(type));
  let attrStr = '';

  if (attributes) {
    for (const [rawName, value] of Object.entries(attributes)) {
      if (rawName === 'key' || value === undefined) continue;
      if (rawName === 'dangerouslySetInnerHTML') {
        const htmlObj = value as {__html?: string} | undefined;
        if (htmlObj?.__html !== undefined) {
          inner = String(htmlObj.__html);
        }
        continue;
      }

      const name = ATTR_NAMES[rawName] ?? rawName;
      if (name === 'class') {
        if (typeof value === 'string') {
          const cls = value.trim();
          if (cls) attrStr += ` class="${escapeHtml(cls)}"`;
        }
        continue;
      }

      if (name === 'style') {
        const css = formatStyle(
          value as Record<string, string | number | boolean | undefined> | string
        );
        if (css) attrStr += ` style="${escapeHtml(css)}"`;
        continue;
      }

      const isFalsifiable = FALSIFIABLE_ATTRIBUTES.has(name) || name.startsWith('aria-');
      if (value === false) {
        if (isFalsifiable) {
          attrStr += ` ${name}="false"`;
        }
      } else if (value === true) {
        attrStr += isFalsifiable ? ` ${name}="true"` : ` ${name}`;
      } else if (typeof value === 'string' || typeof value === 'number') {
        attrStr += ` ${name}="${escapeHtml(String(value))}"`;
      }
    }
  }

  if (VOID_ELEMENTS.has(type)) {
    return new Html(`<${type}${attrStr}>`);
  }
  if (!inner && SVG_SELF_CLOSING_ELEMENTS.has(type)) {
    return new Html(`<${type}${attrStr} />`);
  }
  return new Html(`<${type}${attrStr}>${inner}</${type}>`);
}

export function Fragment(props?: {
  children?: Child;
  dangerouslySetInnerHTML?: {__html: string};
}): Html {
  if (props?.dangerouslySetInnerHTML?.__html !== undefined) {
    return new Html(String(props.dangerouslySetInnerHTML.__html));
  }
  return new Html(props?.children !== undefined ? renderChildren([props.children]) : '');
}

(globalThis as unknown as {h: typeof h; Fragment: typeof Fragment}).h = h;
(globalThis as unknown as {h: typeof h; Fragment: typeof Fragment}).Fragment = Fragment;
