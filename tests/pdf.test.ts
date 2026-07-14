import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildListPdf } from "../src/sync/pdf.js";

const toLatin1 = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
};

describe("PDF export", () => {
  it("emits a structurally valid PDF", () => {
    const bytes = buildListPdf({
      title: "Smart To-Do",
      subtitle: "3 items",
      sections: [
        { name: "Coles", items: ["milk", "eggs"] },
        { name: "Bunnings", items: ["box of screws"] },
      ],
    });
    const pdf = toLatin1(bytes);

    assert.ok(pdf.startsWith("%PDF-1."), "has PDF header");
    assert.ok(pdf.trimEnd().endsWith("%%EOF"), "has EOF marker");
    assert.ok(pdf.includes("/Type /Catalog"));
    assert.ok(pdf.includes("/Type /Pages"));
    assert.ok(pdf.includes("/BaseFont /Helvetica"));
    assert.ok(pdf.includes("/WinAnsiEncoding"));

    // The startxref offset must actually point at the xref table.
    const m = /startxref\n(\d+)\n%%EOF/.exec(pdf);
    assert.ok(m, "has startxref");
    assert.equal(pdf.slice(Number(m![1]), Number(m![1]) + 4), "xref");
  });

  it("includes the list content (titles and section names)", () => {
    const pdf = toLatin1(
      buildListPdf({
        title: "My List",
        sections: [{ name: "Chemist Warehouse", items: ["toothpaste", "vitamin c"] }],
      }),
    );
    assert.ok(pdf.includes("Chemist Warehouse"));
    assert.ok(pdf.includes("toothpaste"));
    assert.ok(pdf.includes("My List"));
  });

  it("paginates long lists across multiple pages", () => {
    const items = Array.from({ length: 120 }, (_, i) => `Item number ${i}`);
    const pdf = toLatin1(buildListPdf({ title: "Big", sections: [{ name: "Coles", items }] }));
    const pageCount = (pdf.match(/\/Type \/Page[^s]/g) ?? []).length;
    assert.ok(pageCount >= 2, `expected multiple pages, got ${pageCount}`);
    const count = /\/Count (\d+)/.exec(pdf);
    assert.ok(count && Number(count[1]) >= 2);
  });

  it("escapes parentheses/backslashes and maps typographic characters", () => {
    // "milk (2%) \\ cream <emdash> caf<e-acute>"
    const item = "milk (2%) \\ cream — café";
    const pdf = toLatin1(buildListPdf({ title: "T", sections: [{ name: "S", items: [item] }] }));
    assert.ok(pdf.includes("\\(2%\\)"), "parens escaped");
    assert.ok(pdf.includes("\\\\"), "backslash escaped");
    assert.ok(pdf.includes("caf" + String.fromCharCode(0xe9)), "e-acute preserved as Latin-1");
    assert.ok(pdf.includes(String.fromCharCode(0x97)), "em dash mapped to WinAnsi byte");
  });

  it("handles an empty list without throwing", () => {
    const pdf = toLatin1(buildListPdf({ title: "Empty", sections: [] }));
    assert.ok(pdf.startsWith("%PDF-1."));
    assert.ok(pdf.includes("/Type /Page"));
  });
});
