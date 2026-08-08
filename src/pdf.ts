/**
 * A minimal PDF writer — enough for a text-and-tables evidence report, nothing more.
 *
 * Why hand-rolled: the alternatives are a headless browser (Cloudflare's rendering
 * API is paid, which breaks the zero-fixed-cost premise the whole product rests on)
 * or a PDF library (none run cleanly on Workers without a bundler, and this repo has
 * no build step). A compliance PDF is black text in rows. That is a few hundred lines
 * of PDF 1.4, and it costs nothing to run forever.
 *
 * Everything is transliterated to ASCII before it is written. PDF base-14 fonts use
 * WinAnsiEncoding, where an arrow "→" simply does not exist and a UTF-8 byte pair
 * would render as mojibake in the middle of an audit document. "72 hours -> 5 days"
 * is honest; "72 hours â†' 5 days" is not.
 */

const PAGE = { width: 612, height: 792, margin: 54 }; // US Letter, 0.75in margins
const LEADING = 1.45;

type FontName = 'F1' | 'F2'; // Helvetica, Helvetica-Bold

interface TextOp {
  text: string;
  x: number;
  y: number;
  size: number;
  font: FontName;
}
interface RuleOp {
  x1: number;
  y: number;
  x2: number;
  gray: number;
}

/** Approximate Helvetica advance widths, in units of font size. */
const NARROW = new Set([...'ijltfr.,:;\'`|!I()[]{}/\\ ']);
const WIDE = new Set([...'mwMW@%']);

function charWidth(ch: string): number {
  if (NARROW.has(ch)) return 0.28;
  if (WIDE.has(ch)) return 0.86;
  if (ch >= 'A' && ch <= 'Z') return 0.68;
  return 0.53;
}

export function measure(text: string, size: number, bold = false): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch);
  return width * size * (bold ? 1.06 : 1);
}

const TRANSLITERATIONS: Record<string, string> = {
  '→': '->', '←': '<-', '↔': '<->', '—': '-', '–': '-', '−': '-',
  '’': "'", '‘': "'", '“': '"', '”': '"', '…': '...', '•': '-', '·': '-',
  '×': 'x', '≥': '>=', '≤': '<=', '≠': '!=', ' ': ' ', '✓': 'Y', '⚠': '!',
};

export function toAscii(text: string): string {
  return [...text]
    .map((ch) => TRANSLITERATIONS[ch] ?? (ch.charCodeAt(0) < 128 ? ch : '?'))
    .join('');
}

/** PDF string literals: only these three bytes are structural. */
const escapePdf = (s: string) => s.replace(/([\\()])/g, '\\$1');

export class PdfDocument {
  private pages: { text: TextOp[]; rules: RuleOp[] }[] = [];
  private current!: { text: TextOp[]; rules: RuleOp[] };
  private y = 0;

  constructor() {
    this.newPage();
  }

  private newPage(): void {
    this.current = { text: [], rules: [] };
    this.pages.push(this.current);
    this.y = PAGE.height - PAGE.margin;
  }

  private ensure(space: number): void {
    if (this.y - space < PAGE.margin + 24) this.newPage();
  }

  get contentWidth(): number {
    return PAGE.width - PAGE.margin * 2;
  }

  /** Greedy wrap. Long unbreakable tokens are hard-split rather than overflowing. */
  private wrap(text: string, width: number, size: number, bold: boolean): string[] {
    const lines: string[] = [];
    let line = '';
    for (const word of toAscii(text).split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate, size, bold) <= width || !line) {
        if (measure(candidate, size, bold) > width && !line) {
          let chunk = '';
          for (const ch of candidate) {
            if (measure(chunk + ch, size, bold) > width) {
              lines.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
          continue;
        }
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  text(content: string, opts: { size?: number; bold?: boolean; gap?: number; indent?: number } = {}): this {
    const size = opts.size ?? 10;
    const bold = opts.bold ?? false;
    const indent = opts.indent ?? 0;
    for (const line of this.wrap(content, this.contentWidth - indent, size, bold)) {
      this.ensure(size * LEADING);
      this.current.text.push({ text: line, x: PAGE.margin + indent, y: this.y, size, font: bold ? 'F2' : 'F1' });
      this.y -= size * LEADING;
    }
    this.y -= opts.gap ?? 0;
    return this;
  }

  heading(content: string, size = 14): this {
    this.ensure(size * 2.4);
    this.y -= 6;
    return this.text(content, { size, bold: true, gap: 4 });
  }

  rule(gray = 0.8): this {
    this.ensure(8);
    this.current.rules.push({ x1: PAGE.margin, x2: PAGE.width - PAGE.margin, y: this.y + 4, gray });
    this.y -= 10;
    return this;
  }

  keyValue(label: string, value: string): this {
    const labelWidth = 130;
    const lines = this.wrap(value, this.contentWidth - labelWidth, 10, false);
    this.ensure(lines.length * 10 * LEADING);
    this.current.text.push({ text: toAscii(label), x: PAGE.margin, y: this.y, size: 10, font: 'F2' });
    lines.forEach((line, i) => {
      this.current.text.push({ text: line, x: PAGE.margin + labelWidth, y: this.y - i * 10 * LEADING, size: 10, font: 'F1' });
    });
    this.y -= lines.length * 10 * LEADING;
    return this;
  }

  /**
   * Headers repeat after a page break. An evidence table whose columns are only
   * labelled on page 1 is unreadable in the place it matters — page 7.
   */
  table(headers: string[], rows: string[][], widths: number[], size = 9): this {
    const scale = this.contentWidth / widths.reduce((a, b) => a + b, 0);
    const cols = widths.map((w) => w * scale);

    const drawHeader = () => {
      this.ensure(size * LEADING * 2);
      let x = PAGE.margin;
      headers.forEach((h, i) => {
        this.current.text.push({ text: toAscii(h), x, y: this.y, size, font: 'F2' });
        x += cols[i];
      });
      this.y -= size * LEADING;
      this.current.rules.push({ x1: PAGE.margin, x2: PAGE.width - PAGE.margin, y: this.y + 5, gray: 0.6 });
      this.y -= 4;
    };

    drawHeader();
    for (const row of rows) {
      const cells = row.map((cell, i) => this.wrap(cell, cols[i] - 8, size, false));
      const height = Math.max(...cells.map((c) => c.length)) * size * LEADING;
      if (this.y - height < PAGE.margin + 24) {
        this.newPage();
        drawHeader();
      }
      let x = PAGE.margin;
      cells.forEach((lines, i) => {
        lines.forEach((line, j) => {
          this.current.text.push({ text: line, x, y: this.y - j * size * LEADING, size, font: 'F1' });
        });
        x += cols[i];
      });
      this.y -= height + 2;
    }
    this.y -= 6;
    return this;
  }

  private footer(pageIndex: number, total: number): TextOp {
    return {
      text: `Page ${pageIndex + 1} of ${total}`,
      x: PAGE.width - PAGE.margin - 60,
      y: PAGE.margin - 18,
      size: 8,
      font: 'F1',
    };
  }

  build(): Uint8Array {
    const objects: string[] = [];
    const add = (body: string) => objects.push(body); // 1-indexed by position

    add(`<< /Type /Catalog /Pages 2 0 R >>`);
    const pageObjectIds = this.pages.map((_, i) => 5 + i * 2);
    add(`<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${this.pages.length} >>`);
    add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
    add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`);

    this.pages.forEach((page, index) => {
      const streamParts = [
        ...page.rules.map((r) => `${r.gray} G 0.5 w ${r.x1} ${r.y} m ${r.x2} ${r.y} l S`),
        ...[...page.text, this.footer(index, this.pages.length)].map(
          (t) => `BT /${t.font} ${t.size} Tf 1 0 0 1 ${t.x.toFixed(2)} ${t.y.toFixed(2)} Tm (${escapePdf(t.text)}) Tj ET`,
        ),
      ];
      const stream = streamParts.join('\n');
      const contentId = 6 + index * 2;
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`,
      );
      add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    });

    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });

    const xrefOffset = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

    // Safe because every string was transliterated to ASCII: one char === one byte,
    // so the xref offsets computed above are byte offsets.
    return new TextEncoder().encode(pdf);
  }
}
