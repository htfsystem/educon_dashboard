/* EduCon Pipeline Dashboard — the workbook writer, shared by every export.
 *
 * A real .xlsx (Office Open XML in a ZIP), written by hand: no library, no CDN, so the
 * dashboard still works fully offline. The predecessor was SpreadsheetML 2003 saved
 * under an .xls name, which made Excel warn "the file format and extension don't match"
 * on every open. A genuine xlsx matches its extension and opens silently.
 *
 * WHY THIS IS ITS OWN FILE
 * Two places export now — the status matrix (js/dashboard.js) and the filtered student
 * list behind a cell (js/students.js) — and a second hand-rolled ZIP/CRC/styles stack
 * would be ~250 lines of the fiddliest code in the codebase, duplicated. One writer
 * means both sheets carry the same styling, the same fixed 1980 timestamp, and the same
 * fix when a version of Excel objects to something.
 *
 * The caller supplies only content: rows, merges, column widths, and which row to freeze.
 * Nothing here knows what a status or a student is.
 */
window.EduConXlsx = (() => {
  'use strict';

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /** ZIP with every entry stored uncompressed — the only method needing no deflate. */
  function zipStore(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;

    files.forEach(f => {
      const name = enc.encode(f.name);
      const data = enc.encode(f.data);
      const crc = crc32(data);

      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);      // version needed to extract
      lv.setUint16(6, 0x0800, true);  // UTF-8 file names
      lv.setUint16(8, 0, true);       // method 0 = stored
      lv.setUint16(12, 0x0021, true); // fixed 1980-01-01 date, so exports are reproducible
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      local.set(name, 30);

      const cd = new Uint8Array(46 + name.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(14, 0x0021, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      cd.set(name, 46);

      parts.push(local, data);
      offset += local.length + data.length;
      central.push(cd);
    });

    const cdStart = offset;
    let cdSize = 0;
    central.forEach(c => { parts.push(c); cdSize += c.length; });

    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    parts.push(end);

    return new Blob(parts, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  }

  /** 0 -> A, 25 -> Z, 26 -> AA. */
  function colLetter(n) {
    let s = '';
    let i = n + 1;
    while (i > 0) {
      const m = (i - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      i = (i - m - 1) / 26;
    }
    return s;
  }

  const escapeXml = s => String(s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * Style ids, matching the order of <cellXfs> in STYLES_XML below:
   * 0 default · 1 title · 2 info strip · 3 column header · 4 text · 5 number ·
   * 6 team band · 7 subtotal label · 8 subtotal number · 9 grand label · 10 grand number ·
   * 11 note · 12 note key
   */
  const S = {
    def: 0, title: 1, info: 2, head: 3, txt: 4, num: 5,
    sect: 6, totL: 7, tot: 8, grandL: 9, grand: 10, note: 11, noteKey: 12
  };

  /** A cell: numbers stay numeric so Excel can sum them; text goes inline. */
  const xc = (ref, v, s) => {
    const style = s ? ` s="${s}"` : '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
    if (v === null || v === undefined || v === '') return `<c r="${ref}"${style}/>`;
    return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(v)}</t></is></c>`;
  };

  /**
   * Builds one worksheet. `rows` is an array of { cells: [v|{v,s}], s, height },
   * `merges` a list of A1-style ranges, `cols` a list of { w }.
   */
  function sheetXml(rows, merges, cols, freezeRow) {
    const colsXml = cols.length
      ? `<cols>${cols.map((c, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${c.w}" customWidth="1"/>`).join('')}</cols>`
      : '';

    const body = rows.map((r, ri) => {
      const n = ri + 1;
      const cells = r.cells.map((c, ci) => {
        const o = (c && typeof c === 'object' && !Array.isArray(c)) ? c : { v: c, s: r.s };
        return xc(`${colLetter(ci)}${n}`, o.v, o.s === undefined ? r.s : o.s);
      }).join('');
      const h = r.height ? ` ht="${r.height}" customHeight="1"` : '';
      return `<row r="${n}"${h}>${cells}</row>`;
    }).join('');

    const pane = freezeRow
      ? `<sheetView workbookViewId="0"><pane ySplit="${freezeRow}" topLeftCell="A${freezeRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView>`
      : '<sheetView workbookViewId="0"/>';

    const mergeXml = merges.length
      ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
      : '';

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetViews>${pane}</sheetViews>` +
      `<sheetFormatPr defaultRowHeight="15"/>${colsXml}` +
      `<sheetData>${body}</sheetData>${mergeXml}` +
      `<pageMargins left="0.4" right="0.4" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>` +
      `</worksheet>`;
  }

  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="6">
 <font><sz val="11"/><name val="Calibri"/></font>
 <font><b/><sz val="16"/><color rgb="FF1F5FAE"/><name val="Calibri"/></font>
 <font><sz val="10"/><color rgb="FF595959"/><name val="Calibri"/></font>
 <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
 <font><b/><sz val="11"/><name val="Calibri"/></font>
 <font><b/><sz val="10"/><color rgb="FF333333"/><name val="Calibri"/></font>
</fonts>
<fills count="6">
 <fill><patternFill patternType="none"/></fill>
 <fill><patternFill patternType="gray125"/></fill>
 <fill><patternFill patternType="solid"><fgColor rgb="FF2A78D6"/><bgColor indexed="64"/></patternFill></fill>
 <fill><patternFill patternType="solid"><fgColor rgb="FFEEF4FC"/><bgColor indexed="64"/></patternFill></fill>
 <fill><patternFill patternType="solid"><fgColor rgb="FFF2F6FB"/><bgColor indexed="64"/></patternFill></fill>
 <fill><patternFill patternType="solid"><fgColor rgb="FF1F5FAE"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
 <border><left/><right/><top/><bottom/><diagonal/></border>
 <border>
  <left style="thin"><color rgb="FFB7C2CE"/></left>
  <right style="thin"><color rgb="FFB7C2CE"/></right>
  <top style="thin"><color rgb="FFB7C2CE"/></top>
  <bottom style="thin"><color rgb="FFB7C2CE"/></bottom>
  <diagonal/>
 </border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="13">
 <xf xfId="0" numFmtId="0" fontId="0" fillId="0" borderId="0"/>
 <xf xfId="0" numFmtId="0" fontId="1" fillId="0" borderId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
 <xf xfId="0" numFmtId="0" fontId="2" fillId="0" borderId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
 <xf xfId="0" numFmtId="0" fontId="3" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
 <xf xfId="0" numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
 <xf xfId="0" numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
 <xf xfId="0" numFmtId="0" fontId="4" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
 <xf xfId="0" numFmtId="0" fontId="4" fillId="4" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
 <xf xfId="0" numFmtId="0" fontId="4" fillId="4" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
 <xf xfId="0" numFmtId="0" fontId="3" fillId="5" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
 <xf xfId="0" numFmtId="0" fontId="3" fillId="5" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
 <xf xfId="0" numFmtId="0" fontId="2" fillId="0" borderId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>
 <xf xfId="0" numFmtId="0" fontId="5" fillId="0" borderId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  /**
   * A workbook of one or more sheets, as a Blob.
   *
   * Each sheet is `{ name, rows, merges = [], cols = [], freezeRow = 0 }`. The sheet
   * name is what appears on Excel's tab; Excel rejects a few characters in it and caps
   * it at 31, so it is sanitised here rather than at every call site.
   */
  function workbook(sheets) {
    const tabName = (name, i) => String(name || `Sheet${i + 1}`)
      .replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);

    const overrides = sheets.map((_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');

    const sheetTags = sheets.map((s, i) =>
      `<sheet name="${escapeXml(tabName(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');

    // The styles part takes the id after the last sheet, so adding a sheet never
    // silently steals the relationship id styles.xml is referenced by.
    const rels = sheets.map((_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;

    const files = [
      {
        name: '[Content_Types].xml',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${overrides}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`
      },
      {
        name: '_rels/.rels',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
      },
      {
        name: 'xl/workbook.xml',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetTags}</sheets>
</workbook>`
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels}
</Relationships>`
      },
      { name: 'xl/styles.xml', data: STYLES_XML }
    ];

    sheets.forEach((s, i) => files.push({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: sheetXml(s.rows, s.merges || [], s.cols || [], s.freezeRow || 0)
    }));

    return zipStore(files);
  }

  /** Hands the workbook to the browser as a download. */
  function save(sheets, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(workbook(sheets));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /** Safe for a Windows/macOS filename, and never empty. */
  const safeName = s => String(s ?? '').replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ').trim().replace(/^[.-]+|[.-]+$/g, '') || 'export';

  return { S, colLetter, workbook, save, safeName };
})();
