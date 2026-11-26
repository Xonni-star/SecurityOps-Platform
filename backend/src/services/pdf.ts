// Minimal single-page PDF generator for text reports. The previous inline
// templates hard-coded an invalid xref offset and used a JS string length for
// /Length, which broke exports containing umlauts. Build the objects once and
// derive every byte offset from the final buffer.
export function pdfReport(text:string){
  const content=`BT /F1 9 Tf 36 756 Td (${text}) Tj ET`;
  const objects=[
    '<< /Type /Catalog /Pages 2 0 R>>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1>>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R>>>>>>',
    `<< /Length ${Buffer.byteLength(content,'utf8')}>>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica>>',
  ];
  let pdf='%PDF-1.4\n';
  const offsets=objects.map((object,index)=>{
    const offset=Buffer.byteLength(pdf,'utf8');
    pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xrefOffset=Buffer.byteLength(pdf,'utf8');
  pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for(const offset of offsets)pdf+=`${String(offset).padStart(10,'0')} 00000 n \n`;
  pdf+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf,'utf8');
}
