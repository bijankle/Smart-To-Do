/**
 * A tiny, zero-dependency PDF writer — just enough to print the lists.
 *
 * The app is offline-first with no runtime dependencies, so rather than pull in
 * a PDF library we emit a minimal, valid PDF by hand: standard Helvetica /
 * Helvetica-Bold (the 14 built-in fonts need no embedding), WinAnsi-encoded
 * text, and one content stream per page. It covers exactly what a printed
 * shopping list needs — a title, bold section headers, and bulleted items with
 * word-wrap and automatic page breaks — and nothing more.
 *
 * Pure and DOM-free, so it runs under `node --test`.
 */

export interface PdfSection {
  name: string;
  items: string[];
}

export interface PdfInput {
  title: string;
  subtitle?: string;
  sections: PdfSection[];
}

// A4 in PostScript points.
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 54;

interface TextOp {
  x: number;
  y: number; // PDF baseline (origin bottom-left)
  size: number;
  bold: boolean;
  text: string;
}

/** WinAnsi byte for the handful of typographic characters above Latin-1. */
const WINANSI: Record<string, number> = {
  "€": 0x80,
  "‚": 0x82,
  "„": 0x84,
  "…": 0x85,
  "†": 0x86,
  "‡": 0x87,
  "‰": 0x89,
  "‹": 0x8b,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
  "™": 0x99,
  "›": 0x9b,
};

/**
 * Escape a string into PDF literal-string bytes under WinAnsiEncoding.
 * Characters that WinAnsi can't represent (emoji, CJK, …) become "?".
 */
function pdfEscape(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    let byte: number;
    if (ch === "(" || ch === ")" || ch === "\\") {
      out += "\\" + ch;
      continue;
    } else if (code <= 0x7f || (code >= 0xa0 && code <= 0xff)) {
      byte = code;
    } else if (WINANSI[ch] !== undefined) {
      byte = WINANSI[ch]!;
    } else {
      byte = 0x3f; // "?"
    }
    out += String.fromCharCode(byte);
  }
  return out;
}

/** Approximate wrap: Helvetica averages ~0.5em per glyph, good enough to print. */
function wrap(text: string, size: number, maxWidth: number): string[] {
  const maxChars = Math.max(8, Math.floor(maxWidth / (size * 0.5)));
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word.length > maxChars ? word.slice(0, maxChars) : word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Lay text out into pages, breaking when the next line would cross the margin. */
function layout(input: PdfInput): TextOp[][] {
  const pages: TextOp[][] = [];
  let page: TextOp[] = [];
  let y = PAGE_H - MARGIN;

  const flush = () => {
    pages.push(page);
    page = [];
    y = PAGE_H - MARGIN;
  };

  const draw = (text: string, size: number, bold: boolean, indent: number, topGap: number) => {
    const lineHeight = size * 1.35;
    if (page.length > 0 && y - (topGap + lineHeight) < MARGIN) flush();
    else y -= topGap;
    y -= lineHeight;
    page.push({ x: MARGIN + indent, y: y + size * 0.25, size, bold, text });
  };

  draw(input.title, 22, true, 0, 0);
  if (input.subtitle) draw(input.subtitle, 10, false, 0, 4);

  const usable = PAGE_W - 2 * MARGIN;
  for (const section of input.sections) {
    draw(section.name, 14, true, 0, 18);
    if (section.items.length === 0) {
      draw("(empty)", 11, false, 14, 2);
      continue;
    }
    for (const item of section.items) {
      const lines = wrap(item, 11, usable - 16);
      lines.forEach((ln, i) => draw((i === 0 ? "•  " : "   ") + ln, 11, false, 14, 2));
    }
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

/** Render one page's text ops into a PDF content stream (absolute positioning). */
function contentStream(ops: TextOp[]): string {
  const parts = ["BT"];
  for (const op of ops) {
    parts.push(`/${op.bold ? "F2" : "F1"} ${op.size} Tf`);
    parts.push(`1 0 0 1 ${op.x.toFixed(2)} ${op.y.toFixed(2)} Tm`);
    parts.push(`(${pdfEscape(op.text)}) Tj`);
  }
  parts.push("ET");
  return parts.join("\n");
}

/** Build a complete PDF document and return its raw bytes. */
export function buildListPdf(input: PdfInput): Uint8Array {
  const pages = layout(input);
  if (pages.length === 0) pages.push([]);

  // Object numbering: 1 Catalog, 2 Pages, 3 F1, 4 F2, then per page a Page
  // object and a Contents stream object.
  const objects: string[] = [];
  const pageObjNums: number[] = [];
  const FIRST_PAGE_OBJ = 5;

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[3] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

  let objNum = FIRST_PAGE_OBJ;
  for (const ops of pages) {
    const pageNum = objNum++;
    const contentNum = objNum++;
    pageObjNums.push(pageNum);
    objects[pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNum} 0 R >>`;
    const stream = contentStream(ops);
    objects[contentNum] =
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }

  const kids = pageObjNums.map((n) => `${n} 0 R`).join(" ");
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageObjNums.length} >>`;

  // Serialize with a cross-reference table. Every byte is <= 0xFF (WinAnsi),
  // so string length equals byte length and xref offsets are exact.
  const maxObj = objNum - 1;
  let body = "%PDF-1.4\n";
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let i = 1; i <= maxObj; i++) {
    if (!objects[i]) continue;
    offsets[i] = body.length;
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefStart = body.length;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxObj; i++) {
    const off = offsets[i] ?? 0;
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  const trailer =
    `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  const pdf = body + xref + trailer;
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}
