/**
 * A tiny, zero-dependency PDF writer — just enough to print the lists, styled
 * to match the app's Blurprint look (blurple header band, tinted pill-style
 * section headers, blurple bullets).
 *
 * The app is offline-first with no runtime dependencies, so rather than pull in
 * a PDF library we emit a minimal, valid PDF by hand: the built-in Helvetica /
 * Helvetica-Bold fonts (no embedding needed), WinAnsi-encoded text, coloured
 * fills and rounded rectangles, and a two-column flow so the lists use the
 * whole page instead of a lonely left margin. Long sections continue across
 * columns/pages with a "(cont.)" header, and every page gets a footer.
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

// ---- geometry (A4, PostScript points) --------------------------------------
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MX = 44; // side margin
const COL_GAP = 26;
const COLS = 2;
const COL_W = (PAGE_W - 2 * MX - COL_GAP * (COLS - 1)) / COLS;
const BAND_H = 96; // blurple title band on page 1
const HDR_H = 52; // slim running header on later pages
const BOTTOM = 52; // keep content above this y
const FOOTER_Y = 30;

const GAP_BEFORE_HEADER = 13;
const HEADER_H = 22;
const GAP_AFTER_HEADER = 8;
const LINE_H = 14;
const ITEM_SIZE = 10.5;
const BULLET_INDENT = 14;

// ---- palette (from theme.css), as PDF 0..1 rgb ------------------------------
type Rgb = readonly [number, number, number];
const ACCENT: Rgb = [88 / 255, 101 / 255, 242 / 255];
const ACCENT_DEEP: Rgb = [71 / 255, 82 / 255, 196 / 255];
const ACCENT_TINT: Rgb = [238 / 255, 240 / 255, 254 / 255];
const TEXT: Rgb = [46 / 255, 48 / 255, 53 / 255];
const MUTED: Rgb = [128 / 255, 132 / 255, 142 / 255];
const BORDER: Rgb = [227 / 255, 229 / 255, 232 / 255];
const WHITE: Rgb = [1, 1, 1];
const BAND_SUB: Rgb = [0.86, 0.88, 1];

const n = (v: number): string => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};
const rgb = (c: Rgb): string => `${n(c[0])} ${n(c[1])} ${n(c[2])}`;

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

/** Escape a string into PDF literal-string bytes under WinAnsiEncoding. */
function pdfEscape(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch === "(" || ch === ")" || ch === "\\") {
      out += "\\" + ch;
      continue;
    }
    const code = ch.codePointAt(0)!;
    let byte: number;
    if (code <= 0x7f || (code >= 0xa0 && code <= 0xff)) byte = code;
    else if (WINANSI[ch] !== undefined) byte = WINANSI[ch]!;
    else byte = 0x3f; // "?"
    out += String.fromCharCode(byte);
  }
  return out;
}

/** Approximate wrap: Helvetica averages ~0.5em per glyph, good enough to print. */
function wrap(text: string, size: number, maxWidth: number): string[] {
  const maxChars = Math.max(6, Math.floor(maxWidth / (size * 0.5)));
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

/**
 * Flow the sections into columns and pages, emitting a content-stream string
 * per page. Coordinates are PDF-native (origin bottom-left); `y` tracks the top
 * edge of the next element and decreases as we move down the page.
 */
function renderPages(input: PdfInput): string[] {
  const pages: string[][] = [];
  let buf: string[] = [];
  let pageIndex = -1;
  let col = 0;
  let y = 0;
  let currentSection: string | null = null;

  const text = (x: number, baseline: number, size: number, bold: boolean, color: Rgb, str: string) =>
    buf.push(
      `BT /${bold ? "F2" : "F1"} ${size} Tf ${rgb(color)} rg ` +
        `1 0 0 1 ${n(x)} ${n(baseline)} Tm (${pdfEscape(str)}) Tj ET`,
    );

  const rect = (x: number, yBot: number, w: number, h: number, color: Rgb) =>
    buf.push(`${rgb(color)} rg ${n(x)} ${n(yBot)} ${n(w)} ${n(h)} re f`);

  const roundRect = (x: number, yBot: number, w: number, h: number, r: number, color: Rgb) => {
    const k = 0.5523 * r;
    buf.push(
      `${rgb(color)} rg ${n(x + r)} ${n(yBot)} m ${n(x + w - r)} ${n(yBot)} l ` +
        `${n(x + w - r + k)} ${n(yBot)} ${n(x + w)} ${n(yBot + r - k)} ${n(x + w)} ${n(yBot + r)} c ` +
        `${n(x + w)} ${n(yBot + h - r)} l ` +
        `${n(x + w)} ${n(yBot + h - r + k)} ${n(x + w - r + k)} ${n(yBot + h)} ${n(x + w - r)} ${n(yBot + h)} c ` +
        `${n(x + r)} ${n(yBot + h)} l ` +
        `${n(x + r - k)} ${n(yBot + h)} ${n(x)} ${n(yBot + h - r + k)} ${n(x)} ${n(yBot + h - r)} c ` +
        `${n(x)} ${n(yBot + r)} l ` +
        `${n(x)} ${n(yBot + r - k)} ${n(x + r - k)} ${n(yBot)} ${n(x + r)} ${n(yBot)} c f`,
    );
  };

  const colX = () => MX + col * (COL_W + COL_GAP);
  const contentTop = () => PAGE_H - (pageIndex === 0 ? BAND_H : HDR_H) - 18;

  const startPage = () => {
    if (buf.length) pages.push(buf);
    buf = [];
    pageIndex += 1;
    if (pageIndex === 0) {
      rect(0, PAGE_H - BAND_H, PAGE_W, BAND_H, ACCENT);
      text(MX, PAGE_H - 54, 24, true, WHITE, input.title);
      if (input.subtitle) text(MX, PAGE_H - 74, 11, false, BAND_SUB, input.subtitle);
    } else {
      text(MX, PAGE_H - 34, 12, true, ACCENT_DEEP, input.title);
      rect(MX, PAGE_H - 46, PAGE_W - 2 * MX, 0.8, BORDER);
    }
  };

  const drawHeader = (name: string, cont: boolean) => {
    y -= GAP_BEFORE_HEADER;
    const top = y;
    roundRect(colX(), top - HEADER_H, COL_W, HEADER_H, 7, ACCENT_TINT);
    text(colX() + 11, top - HEADER_H + 7.5, 12, true, ACCENT_DEEP, cont ? `${name}  (cont.)` : name);
    y = top - HEADER_H - GAP_AFTER_HEADER;
  };

  const advance = (continued: boolean) => {
    col += 1;
    if (col >= COLS) {
      col = 0;
      startPage();
    }
    y = contentTop();
    if (continued && currentSection) drawHeader(currentSection, true);
  };

  startPage();
  y = contentTop();

  for (const section of input.sections) {
    // Keep the header with at least a couple of its items (avoid orphan headers).
    const need = GAP_BEFORE_HEADER + HEADER_H + GAP_AFTER_HEADER + 2 * LINE_H;
    if (y - need < BOTTOM) {
      currentSection = null;
      advance(false);
    }
    drawHeader(section.name, false);
    currentSection = section.name;

    const items = section.items.length > 0 ? section.items : ["(empty)"];
    for (const item of items) {
      const lines = wrap(item, ITEM_SIZE, COL_W - BULLET_INDENT - 6);
      lines.forEach((ln, i) => {
        if (y - LINE_H < BOTTOM) advance(true);
        const baseline = y - 10.5;
        if (i === 0) text(colX(), baseline, ITEM_SIZE, false, ACCENT, "•");
        text(colX() + BULLET_INDENT, baseline, ITEM_SIZE, false, TEXT, ln);
        y -= LINE_H;
      });
    }
    currentSection = null;
  }
  if (buf.length) pages.push(buf);

  // Footer on every page, once the total is known.
  pages.forEach((pageBuf, i) => {
    buf = pageBuf;
    rect(MX, FOOTER_Y + 12, PAGE_W - 2 * MX, 0.8, BORDER);
    const label = `Page ${i + 1} of ${pages.length}`;
    const width = label.length * 9 * 0.5;
    text((PAGE_W - width) / 2, FOOTER_Y, 9, false, MUTED, label);
  });

  return pages.map((p) => p.join("\n"));
}

/** Build a complete PDF document and return its raw bytes. */
export function buildListPdf(input: PdfInput): Uint8Array {
  const streams = renderPages(input);
  if (streams.length === 0) streams.push("");

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
  for (const stream of streams) {
    const pageNum = objNum++;
    const contentNum = objNum++;
    pageObjNums.push(pageNum);
    objects[pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNum} 0 R >>`;
    objects[contentNum] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }

  const kids = pageObjNums.map((num) => `${num} 0 R`).join(" ");
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
    xref += `${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  const pdf = body + xref + trailer;
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}
