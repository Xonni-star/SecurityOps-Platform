/**
 * Abhängigkeitsfreier XLSX-Export (Office Open XML).
 *
 * Der Bestand nutzt bewusst kein Excel-Paket. Diese Datei erzeugt ein
 * minimales, aber vollständiges Arbeitsbuch: ZIP-Container, Inhaltstypen,
 * Relationships, Styles und ein Arbeitsblatt mit Inline-Strings. Damit bleiben
 * Exporte deterministisch und ohne zusätzliche Produktionsabhängigkeit.
 */
type ZipSource={name:string;data:Buffer};

const CRC_TABLE=(()=>{
  const table=new Uint32Array(256);
  for(let n=0;n<256;n++){
    let c=n;
    for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;
    table[n]=c>>>0;
  }
  return table;
})();

function crc32(buffer:Buffer){
  let crc=0xffffffff;
  for(const byte of buffer)crc=(crc>>>8)^CRC_TABLE[(crc^byte)&0xff];
  return (crc^0xffffffff)>>>0;
}

function zip(files:ZipSource[]){
  const locals:Buffer[]=[];
  const centrals:Buffer[]=[];
  let offset=0;
  for(const file of files){
    const name=Buffer.from(file.name,'utf8');
    const crc=crc32(file.data);
    const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0);
    local.writeUInt16LE(20,4);
    local.writeUInt16LE(0,6);
    local.writeUInt16LE(0,8);
    local.writeUInt16LE(0,10);
    local.writeUInt16LE(0x0021,12);
    local.writeUInt32LE(crc,14);
    local.writeUInt32LE(file.data.length,18);
    local.writeUInt32LE(file.data.length,22);
    local.writeUInt16LE(name.length,26);
    local.writeUInt16LE(0,28);
    locals.push(local,name,file.data);

    const central=Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50,0);
    central.writeUInt16LE(20,4);
    central.writeUInt16LE(20,6);
    central.writeUInt16LE(0,8);
    central.writeUInt16LE(0,10);
    central.writeUInt16LE(0,12);
    central.writeUInt16LE(0x0021,14);
    central.writeUInt32LE(crc,16);
    central.writeUInt32LE(file.data.length,20);
    central.writeUInt32LE(file.data.length,24);
    central.writeUInt16LE(name.length,28);
    central.writeUInt16LE(0,30);
    central.writeUInt16LE(0,32);
    central.writeUInt16LE(0,34);
    central.writeUInt16LE(0,36);
    central.writeUInt32LE(0,38);
    central.writeUInt32LE(offset,42);
    centrals.push(central,name);
    offset+=local.length+name.length+file.data.length;
  }
  const centralSize=centrals.reduce((sum,buffer)=>sum+buffer.length,0);
  const end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);
  end.writeUInt16LE(0,4);
  end.writeUInt16LE(0,6);
  end.writeUInt16LE(files.length,8);
  end.writeUInt16LE(files.length,10);
  end.writeUInt32LE(centralSize,12);
  end.writeUInt32LE(offset,16);
  end.writeUInt16LE(0,20);
  return Buffer.concat([...locals,...centrals,end]);
}

function escapeXml(value:unknown){
  return String(value??'')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&apos;');
}

function columnName(index:number){
  let value=index+1;
  let name='';
  while(value>0){
    const remainder=(value-1)%26;
    name=String.fromCharCode(65+remainder)+name;
    value=Math.floor((value-1)/26);
  }
  return name;
}

const CONTENT_TYPES=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const ROOT_RELS=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Bericht" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const WORKBOOK_RELS=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function worksheet(rows:(string|number|null)[][]){
  const cells=rows.map((row,rowIndex)=>{
    const cellsXml=row.map((value,columnIndex)=>{
      const reference=`${columnName(columnIndex)}${rowIndex+1}`;
      const style=rowIndex===0?' s="1"':'';
      return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex+1}">${cellsXml}</row>`;
  }).join('');
  const columnCount=Math.max(1,...rows.map(row=>row.length));
  const dimension=`A1:${columnName(columnCount-1)}${Math.max(1,rows.length)}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="${dimension}"/>
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <sheetData>${cells}</sheetData>
</worksheet>`;
}

/** Erzeugt ein gültiges, einblattiges XLSX aus bereits formatierten Zeilen. */
export function xlsxWorkbook(rows:(string|number|null)[][]):Buffer{
  const files:ZipSource[]=[
    {name:'[Content_Types].xml',data:Buffer.from(CONTENT_TYPES,'utf8')},
    {name:'_rels/.rels',data:Buffer.from(ROOT_RELS,'utf8')},
    {name:'xl/workbook.xml',data:Buffer.from(WORKBOOK,'utf8')},
    {name:'xl/_rels/workbook.xml.rels',data:Buffer.from(WORKBOOK_RELS,'utf8')},
    {name:'xl/styles.xml',data:Buffer.from(STYLES,'utf8')},
    {name:'xl/worksheets/sheet1.xml',data:Buffer.from(worksheet(rows),'utf8')},
  ];
  return zip(files);
}
