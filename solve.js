// Fast CSV reader with csv-reader 1.0.0's exact broken-row semantics.
//
// Written from scratch for speed: the input is scanned with indexOf for the
// next delimiter instead of one character at a time, whole fields are taken
// with slice(), and quoted fields are taken as one slice up to their closing
// quote. The slow, character-wise paths only run on the rare broken inputs
// (a stray CR, a doubled quote, a line break inside quotes, junk after a
// closing quote, a quote that never closes), so the common case stays on
// V8's fast string primitives.
//
// Behaviour (matching the reference exactly):
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next quote that is not doubled,
//     "" inside it is one quote, each CRLF or lone CR inside it reads as LF;
//     what follows its closing quote up to the next comma or line break is
//     appended as it stands (quote_junk, when the field ends); a quote that
//     never closes is a literal character and the text after it is read again
//     as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded with "" (short_row, with fields: its
//     field count) or cut (long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row}, in the order met; line is the 1-based
//     line its record starts on (counting every LF, CRLF and lone CR inside
//     quotes), row is its record's index in rows (null for the header).
//
// Pure: no clock, no randomness, no state kept from one call to the next.

// How a field ended: 0 = comma (record goes on), 1 = line break, 2 = end of text.
const AT_COMMA = 0;
const AT_BREAK = 1;
const AT_END = 2;

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  const s = String(input.text);
  const header = input.header === true;
  const n = s.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // next character to read
  let line = 1; // line that character is on
  if (s.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on, its index in rows (null: header).
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    const entry = { code: code, line: recordLine, row: recordRow };
    errors.push(entry);
  }

  // Reads unquoted characters starting from `init` up to the next comma or
  // line break. A CR not followed by LF is dropped (stray_cr). Returns the
  // field and how it ended; `added` counts the characters kept from the text
  // (not counting `init`).
  function readUnquoted(init) {
    const iComma = s.indexOf(',', pos);
    const iLf = s.indexOf('\n', pos);
    let end;
    let ended;
    if (iComma === -1 && iLf === -1) {
      end = n;
      ended = AT_END;
    } else if (iLf === -1 || (iComma !== -1 && iComma < iLf)) {
      end = iComma;
      ended = AT_COMMA;
    } else {
      end = iLf;
      ended = AT_BREAK;
    }
    const seg = s.slice(pos, end);
    const r = seg.indexOf('\r');
    if (r === -1) {
      // No CR in the field: one slice is the whole value.
      if (ended === AT_END) pos = n;
      else if (ended === AT_COMMA) pos = end + 1;
      else {
        pos = end + 1;
        line += 1;
      }
      return { value: init === '' ? seg : init + seg, ended, added: seg.length };
    }
    // A CR sits inside the field. A trailing CR before an LF is the CRLF
    // line break, not part of the value; every other CR is a stray CR.
    let limit = seg.length;
    if (ended === AT_BREAK && seg.charCodeAt(limit - 1) === 13) limit -= 1;
    let value = init;
    let added = 0;
    let p = 0;
    for (;;) {
      const idx = seg.indexOf('\r', p);
      if (idx === -1 || idx >= limit) break;
      error('stray_cr');
      if (idx > p) {
        value += seg.slice(p, idx);
        added += idx - p;
      }
      p = idx + 1;
    }
    if (limit > p) {
      value += seg.slice(p, limit);
      added += limit - p;
    }
    if (ended === AT_END) pos = n;
    else if (ended === AT_COMMA) pos = end + 1;
    else {
      pos = end + 1;
      line += 1;
    }
    return { value, ended, added };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let p = pos + 1;
    for (;;) {
      const q = s.indexOf('"', p);
      if (q === -1) {
        // No closing quote anywhere ahead: the opening quote counts as a
        // plain character, and scanning restarts just past it, unquoted.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      let seg = s.slice(p, q);
      if (seg.indexOf('\n') !== -1 || seg.indexOf('\r') !== -1) {
        // CRLF and a lone CR inside quotes each become one LF.
        let breaks = 0;
        seg = seg.replace(/\r\n|\r|\n/g, () => {
          breaks += 1;
          return '\n';
        });
        line += breaks;
      }
      if (s.charCodeAt(q + 1) === 34) {
        // A doubled quote is one literal quote; the field goes on.
        value += seg;
        value += '"';
        p = q + 2;
        continue;
      }
      value += seg;
      pos = q + 1;
      if (pos >= n) return { value, ended: AT_END };
      const c = s.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        return { value, ended: AT_COMMA };
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        return { value, ended: AT_BREAK };
      }
      if (c === 13 && s.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        return { value, ended: AT_BREAK };
      }
      // Characters after the closing quote join the field as they stand,
      // up to the next comma or line break.
      const tail = readUnquoted(value);
      if (tail.added > 0) error('quote_junk');
      return tail;
    }
  }

  for (;;) {
    // Skip lines that hold no characters: they are not records.
    while (pos < n) {
      const c = s.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && s.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    if (header && columns === null) recordRow = null;
    else recordRow = rows.length;
    const fields = [];
    let field;
    let quoted = false;
    for (;;) {
      quoted = s.charCodeAt(pos) === 34;
      if (quoted) field = readQuoted();
      else field = readUnquoted('');
      fields.push(field.value);
      if (field.ended !== AT_COMMA) break;
    }

    // A line holding only stray CRs ends up with no characters: it is not
    // a record, though its stray_cr errors stay recorded.
    const onlyStrayCrs = fields.length === 1 && fields[0] === '' && !quoted;
    if (onlyStrayCrs) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      const shortErr = {
        code: 'short_row',
        line: recordLine,
        row: recordRow,
        fields: fields.length,
      };
      errors.push(shortErr);
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      const cut = fields.slice(width);
      fields.length = width;
      const longErr = {
        code: 'long_row',
        line: recordLine,
        row: recordRow,
        extra: cut,
      };
      errors.push(longErr);
    }
    rows.push(fields);
  }
  const answer = {
    columns: header ? (columns === null ? [] : columns) : null,
    rows: rows,
    errors: errors,
  };
  return answer;
}
