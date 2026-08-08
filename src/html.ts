/**
 * Shared HTML → text primitives.
 *
 * Both extractors need these, and they need them to agree: if the table parser and
 * the text normalizer decoded entities differently, the same page would produce a
 * different `contentHash` depending on which path read it.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…',
};

export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}

/** Removes markup that is never page content. */
export function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ');
}

/**
 * Removes site chrome — the nav, footer, and cookie banner that change on every
 * deploy and would otherwise dominate every text diff.
 *
 * Tag-based only. Chrome built from anonymous <div>s survives this, which is exactly
 * what `learnedNoisePatterns` on the watch is for: the per-watch escape hatch for
 * boilerplate a generic stripper can't see.
 */
export function stripChrome(html: string): string {
  return html.replace(/<(nav|footer|header|aside|form)\b[\s\S]*?<\/\1>/gi, ' ');
}

/** Collapses an HTML fragment to a single line of text. Used for table cells. */
export function inlineText(html: string): string {
  return decodeHtmlEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

const BLOCK_END =
  /<\/(p|div|section|article|li|tr|h[1-6]|blockquote|td|th|table|ul|ol|dl|dd|dt|main|figure|pre)\s*>/gi;

/**
 * Full page text, with block boundaries preserved as newlines.
 *
 * The newlines are not cosmetic — `extractClauses` scans line by line, so flattening
 * a DPA into one line here would silently disable clause detection for every page in
 * the system.
 */
export function htmlToText(html: string): string {
  return decodeHtmlEntities(
    stripChrome(stripNonContent(html))
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(BLOCK_END, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}
