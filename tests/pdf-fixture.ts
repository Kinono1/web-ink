/** Small, original synthetic PDF. Byte offsets are calculated; no downloaded paper or personal content. */
export function fixturePdf(
  pages = 1,
  text = "Web Ink PDF highlights survive a return visit.",
): Buffer {
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const font = 3;
  const unicode = /[^\x00-\x7f]/.test(text);
  if (unicode) {
    objects.push('<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>');
    objects.push('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 5 0 R /DW 1000 >>');
    objects.push('<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>');
  } else objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const encoded = (value:string) => unicode ? `<${Array.from(value, c => c.charCodeAt(0).toString(16).padStart(4,'0')).join('')}>` : `(${value.replace(/[\\()]/g, '\\$&')})`;
  const kids: number[] = [];
  for (let i = 0; i < pages; i++) {
    const pageId = objects.length + 1,
      contentId = pageId + 1;
    kids.push(pageId);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    const content = `BT /F1 18 Tf 48 730 Td ${encoded(text)} Tj 0 -30 Td ${encoded(`Synthetic reading fixture - page ${i + 1}`)} Tj ET\nBT /F1 12 Tf 330 640 Td ${encoded(unicode ? '右栏独立的研究结果' : 'Second column, separate finding.')} Tj ET\n0.15 0.4 0.8 rg 70 420 180 120 re f\n`;
    objects.push(
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    );
  }
  objects[1] = `<< /Type /Pages /Count ${pages} /Kids [${kids.map((n) => `${n} 0 R`).join(" ")}] >>`;
  let output = "%PDF-1.7\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(output));
    output += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
