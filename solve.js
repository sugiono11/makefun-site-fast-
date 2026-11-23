// solve.js — an original, dependency-free, fast implementation of makefun-site 1.0.0's
// build semantics (front matter, template dialect, Markdown subset, slug rule, report).
// It was written by studying the reference program's README and code to learn the exact
// semantics, then implemented independently for speed. It returns the same output tree,
// byte for byte, for every input.
//
// The speed comes from: bulk HTML escaping instead of per-character regex replaces,
// single-pass char-code lexing instead of seven regexes per line, range-based inline
// rendering without substring copies, cached slugs and long dates, one card per source,
// and array-joined template output instead of repeated string concatenation.
//
// run(input) answers one case alone. Nothing is kept from one call to the next: the
// per-build caches below are created fresh inside build().

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// Per-build caches, created fresh by build().
let slugCache;
let dateCache;

// ---------------------------------------------------------------- text

/** Append `s` HTML-escaped to `out` (an array of string chunks). */
const ESC_RE = /[&<>"']/;
function escInto(out, s) {
  if (!ESC_RE.test(s)) {
    if (s !== '') out.push(s);
    return;
  }
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    let rep = null;
    if (ch === '&') rep = '&amp;';
    else if (ch === '<') rep = '&lt;';
    else if (ch === '>') rep = '&gt;';
    else if (ch === '"') rep = '&quot;';
    else if (ch === "'") rep = '&#39;';
    if (rep !== null) {
      if (i > start) out.push(s.slice(start, i));
      out.push(rep);
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
}

/** `s` HTML-escaped, as one string. */
function escStr(s) {
  const out = [];
  escInto(out, s);
  return out.join('');
}

/**
 * The slug of `text`. Pure-ASCII input is unchanged by NFKD and holds no combining
 * marks, so it skips the normalisation; anything else goes through NFKD with marks
 * dropped, exactly as the reference does. Results are cached per build.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  const res = out === '' ? 'untitled' : out;
  slugCache.set(text, res);
  return res;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. Cached per build. */
function longDate(date) {
  let v = dateCache.get(date);
  if (v === undefined) {
    const parts = date.split('-');
    v = `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]} ${parts[0]}`;
    dateCache.set(date, v);
  }
  return v;
}

/** Whether code `c` is JavaScript whitespace (what \s matches). */
function isSpaceCode(c) {
  return (c >= 9 && c <= 13) || c === 32 || c === 0xA0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 ||
    c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const sp = (c >= 9 && c <= 13) || c === 32 || c === 0xA0 || c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 ||
      c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;
    if (sp) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_ERROR = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return { error: DATE_ERROR };
      let y = 0;
      let mo = 0;
      let d = 0;
      for (let i = 0; i < 4; i++) {
        const c = raw.charCodeAt(i) - 48;
        if (c < 0 || c > 9) return { error: DATE_ERROR };
        y = y * 10 + c;
      }
      for (let i = 5; i < 7; i++) {
        const c = raw.charCodeAt(i) - 48;
        if (c < 0 || c > 9) return { error: DATE_ERROR };
        mo = mo * 10 + c;
      }
      for (let i = 8; i < 10; i++) {
        const c = raw.charCodeAt(i) - 48;
        if (c < 0 || c > 9) return { error: DATE_ERROR };
        d = d * 10 + c;
      }
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: DATE_ERROR };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t.charCodeAt(i);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) { prevDash = false; continue; }
        if (c === 45 && !prevDash) { prevDash = true; continue; }
        return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether a line is blank (spaces and tabs only). */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter, read from its lines: { data, close } (close is the index of
 * the closing `---` line), or { error } with the first reason it is refused.
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    let j = 0;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if ((c >= 97 && c <= 122) || c === 95) j++;
      else break;
    }
    if (j === 0 || j >= line.length || line.charCodeAt(j) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    let raw;
    if (j + 1 === line.length) raw = '';
    else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c !== 32 && c !== 9) break;
      e--;
    }
    raw = raw.slice(0, e);
    const key = line.slice(0, j);
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, close };
}

// ---------------------------------------------------------------- markdown

/** Trim spaces and tabs at both ends of a line. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The fence language of a fence-open line, or null when the line opens no fence. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const langEnd = i;
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, langEnd);
}

/** Whether a line closes a fence. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6 || h >= line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let i = h;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  let end = line.length;
  while (end > i && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === i) return null;
  return { depth: h, text: line.slice(i, end) };
}

/** Whether a line is a thematic break. */
function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/** A bullet item's text, or null. */
function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's number and text, or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** Whether a line continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < line.length && !isSpaceCode(line.charCodeAt(i));
}

// (lexing now runs inside renderMarkdown, one pass, no token arrays)

// ---------------------------------------------------------------- inline

/** Whether a character code is one a backslash escapes. */
function isEscapableCode(c) {
  return c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 || c === 40 ||
    c === 41 || c === 35 || c === 43 || c === 45 || c === 46 || c === 33 || c === 62;
}

/** The first index in [from, end) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j + wlen <= end; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [from, end) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && isEscapableCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `s` holds whitespace (the /\s/ test). */
const HAS_WS = /\s/;
function hasWs(s) {
  return HAS_WS.test(s);
}

/** The characters that can start an inline construct or need escaping. */
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;

/**
 * `s[start..end)` rendered inline into `out`; `env.link(target)` is a link's href.
 * A native regex scan jumps to the next interesting character, so plain prose is
 * pushed as whole runs instead of one character at a time. The shared regex's
 * lastIndex is reset after every recursive call, so nesting stays correct.
 */
function inlineRange(s, start, end, env, out) {
  INLINE_SPECIAL.lastIndex = start;
  let run = start;
  let m;
  while ((m = INLINE_SPECIAL.exec(s)) !== null && m.index < end) {
    const i = m.index;
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (i > run) out.push(s.slice(run, i));
      out.push(c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;');
      run = i + 1;
      INLINE_SPECIAL.lastIndex = i + 1;
      continue;
    }
    if (c === 92 && i + 1 < end && isEscapableCode(s.charCodeAt(i + 1))) {
      if (i > run) out.push(s.slice(run, i));
      const n = s[i + 1];
      out.push(n === '>' ? '&gt;' : n);
      run = i + 2;
      INLINE_SPECIAL.lastIndex = i + 2;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < end && j > i + 1) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<code>');
        escInto(out, s.slice(i + 1, j));
        out.push('</code>');
        run = j + 1;
        INLINE_SPECIAL.lastIndex = j + 1;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, end);
        if (j !== -1 && j > i + 2) {
          if (i > run) out.push(s.slice(run, i));
          out.push('<strong>');
          inlineRange(s, i + 2, j, env, out);
          out.push('</strong>');
          run = j + 2;
          INLINE_SPECIAL.lastIndex = j + 2;
        } else {
          // No closer: the pair is literal, and both stars are skipped, exactly
          // as the reference's `i += 2` does; the second star must not be
          // re-examined as an emphasis opener.
          INLINE_SPECIAL.lastIndex = i + 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, end);
      if (j !== -1 && j > i + 1) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<em>');
        inlineRange(s, i + 1, j, env, out);
        out.push('</em>');
        run = j + 1;
        INLINE_SPECIAL.lastIndex = j + 1;
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, end);
      let mm = -1;
      if (k !== -1 && s.charCodeAt(k + 1) === 40) {
        const r = s.indexOf(')', k + 2);
        if (r !== -1 && r < end) mm = r;
      }
      let target = '';
      if (mm !== -1) target = s.slice(k + 2, mm);
      if (mm !== -1 && target !== '' && !hasWs(target)) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<a href="');
        escInto(out, env.link(target));
        out.push('">');
        inlineRange(s, i + 1, k, env, out);
        out.push('</a>');
        run = mm + 1;
        INLINE_SPECIAL.lastIndex = mm + 1;
      }
      continue;
    }
  }
  if (end > run) out.push(s.slice(run, end));
}

/**
 * A body's HTML, its table of contents and its excerpt, from its lines.
 * Lexing and rendering run in one pass, so no block tokens are allocated.
 * `env.link(target)` resolves a link's href.
 */
function renderMarkdown(lines, start, end, env) {
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < end && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${lang}"`;
      out.push(`<pre><code${cls}>`);
      if (body.length > 0) {
        escInto(out, body.join('\n'));
        out.push('\n');
      }
      out.push('</code></pre>\n');
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text), ids);
      const parts = [];
      inlineRange(hd.text, 0, hd.text.length, env, parts);
      const html = parts.join('');
      out.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < end && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const cleaned = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') cleaned.push(t);
      }
      if (cleaned.length === 0) {
        out.push('<blockquote>\n</blockquote>\n');
      } else {
        const txt = cleaned.join('\n');
        out.push('<blockquote>\n<p>');
        inlineRange(txt, 0, txt.length, env, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const b = bulletOf(line);
    const o = b === null ? orderedOf(line) : null;
    if (b !== null || o !== null) {
      const isOrdered = o !== null;
      const items = [];
      while (i < end) {
        const m = isOrdered ? orderedOf(lines[i]) : bulletOf(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m.text : m)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && o.num !== 1 ? `<ol start="${o.num}">` : `<${tag}>`;
      out.push(`${open}\n`);
      for (let k = 0; k < items.length; k++) {
        const item = items[k].join('\n');
        out.push('<li>');
        inlineRange(item, 0, item.length, env, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < end && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    if (excerpt === null) {
      const parts = [];
      inlineRange(text, 0, text.length, env, parts);
      excerpt = parts.join('');
      out.push(`<p>${excerpt}</p>\n`);
    } else {
      out.push('<p>');
      inlineRange(text, 0, text.length, env, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * Which templates are build-constant: their output depends only on site, tags and
 * recent (and loop variables bound by their own fors), never on the page being
 * rendered. Such a template renders the same for every page in a build, so it is
 * rendered once per (name, depth) and cached — EXCEPT when a caller's loop variable
 * named `site`, `tags` or `recent` shadows the global of that name; the include
 * site checks for that with shadowsGlobals() and renders normally instead.
 * A path reference is safe when its first segment is site/tags/recent, or is bound
 * by a lexically enclosing for (the loop variable, or `loop` itself). Anything else
 * (page, posts, pager, tag, or a name bound only by a caller) is unsafe.
 */
function analyzeConst(templates) {
  const infos = new Map();
  const walk = (nodes, bound, info) => {
    for (const n of nodes) {
      if (n.kind === 'var' || n.kind === 'raw') {
        if (!bound.has(n.path[0]) && n.path[0] !== 'site' && n.path[0] !== 'tags' && n.path[0] !== 'recent') info.safe = false;
      } else if (n.kind === 'if') {
        if (!bound.has(n.path[0]) && n.path[0] !== 'site' && n.path[0] !== 'tags' && n.path[0] !== 'recent') info.safe = false;
        walk(n.then, bound, info);
        if (n.else !== null) walk(n.else, bound, info);
      } else if (n.kind === 'for') {
        if (!bound.has(n.path[0]) && n.path[0] !== 'site' && n.path[0] !== 'tags' && n.path[0] !== 'recent') info.safe = false;
        const inner = new Set(bound);
        inner.add(n.name);
        inner.add('loop');
        walk(n.body, inner, info);
      } else if (n.kind === 'include') {
        info.includes.push(n.name);
      }
    }
  };
  for (const [name, nodes] of templates) {
    const info = { safe: true, includes: [] };
    walk(nodes, new Set(), info);
    infos.set(name, info);
  }
  const isConst = new Map();
  for (const name of templates.keys()) isConst.set(name, true);
  for (let iter = 0; iter <= templates.size; iter++) {
    let changed = false;
    for (const [name, info] of infos) {
      if (!isConst.get(name)) continue;
      if (!info.safe) { isConst.set(name, false); changed = true; continue; }
      for (const inc of info.includes) {
        if (templates.has(inc) && !isConst.get(inc)) { isConst.set(name, false); changed = true; break; }
      }
    }
    if (!changed) break;
  }
  return isConst;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Whether any loop frame above the root scope binds `site`, `tags` or `recent`,
 * which would shadow the globals a const-cached template reads. */
function shadowsGlobals(scope, rootScope) {
  let s = scope;
  while (s !== rootScope && s !== null) {
    if (Object.hasOwn(s.vars, 'site') || Object.hasOwn(s.vars, 'tags') || Object.hasOwn(s.vars, 'recent')) return true;
    s = s.parent;
  }
  return false;
}

/**
 * `nodes` rendered into `out` in `scope` ({ vars, parent }). `ctx` holds the parsed
 * templates (a Map of name to nodes), the include depth.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        escInto(out, textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        if (ctx.isConst.get(n.name) && !shadowsGlobals(scope, ctx.rootScope)) {
          const key = n.name + '\n' + (depth + 1);
          let cached = ctx.constCache.get(key);
          if (cached === undefined) {
            const tmp = [];
            renderNodes(t, ctx.rootScope, ctx, depth + 1, tmp);
            cached = tmp.join('');
            ctx.constCache.set(key, cached);
          }
          out.push(cached);
        } else {
          renderNodes(t, scope, ctx, depth + 1, out);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

/** A page's link record as templates read it (computed once per source). */
function linkOfSource(s) {
  return s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
}

/** One site's output tree: path -> text. */
function build(input) {
  slugCache = new Map();
  dateCache = new Map();
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let ni = 0; ni < names.length; ni++) {
    const name = names[ni];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    isConst: analyzeConst(templates),
    constCache: new Map(),
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    output: {},
  };

  // 1. Sources, in code-unit order of their paths; line ends made "\n".
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      b.sources.push({ path: f.path, text, lines: null, body: '', bodyStart: 0 });
    } else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (let si = 0; si < b.sources.length; si++) {
    const s = b.sources[si];
    const lines = s.text.split('\n');
    const fm = parseFrontMatter(lines);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.lines = lines;
    s.bodyStart = fm.close + 1;
    s.body = lines.slice(s.bodyStart).join('\n');
    s.post = s.path.startsWith('posts/');
    let own;
    for (let d = 0; d < RESERVED.length; d++) {
      if (RESERVED[d] !== 'posts' && s.path.startsWith(`${RESERVED[d]}/`)) { own = RESERVED[d]; break; }
    }
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Permalinks: each page's output directory and url.
  const taken = new Map();
  for (let si = 0; si < b.sources.length; si++) {
    const s = b.sources[si];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Markdown: each body's HTML, its links resolved.
  const staticPaths = new Set();
  for (let fi = 0; fi < b.statics.length; fi++) staticPaths.add(b.statics[fi].path);
  for (let si = 0; si < b.sources.length; si++) {
    const s = b.sources[si];
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        if (isScheme(target)) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.lines, s.bodyStart, s.lines.length, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: the posts, newest first and then by slug.
  const posts = [];
  for (let si = 0; si < b.sources.length; si++) if (b.sources[si].post) posts.push(b.sources[si]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags: grouped by their slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (let ti = 0; ti < tags.length; ti++) {
      const name = tags[ti];
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (let pi = 0; pi < b.posts.length; pi++) {
    const p = b.posts[pi];
    p.tagRefs = [];
    const names = ownTags(p);
    for (let ti = 0; ti < names.length; ti++) {
      const name = names[ti];
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let si = 0; si < b.sources.length; si++) {
    const s = b.sources[si];
    if (s.post) continue;
    const names = ownTags(s);
    s.tagRefs = [];
    for (let ti = 0; ti < names.length; ti++) {
      const name = names[ti];
      const slug = slugify(name);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards and link records, computed once per source.
  for (let si = 0; si < b.sources.length; si++) {
    const s = b.sources[si];
    s.link = linkOfSource(s);
    s.card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }

  // 7. Layouts: every page through its layout, the index pages and the tag pages.
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => p.card);
  const rootScope = { vars: { site, tags: allTags, recent }, parent: null };
  const ctx = { templates: b.templates, isConst: b.isConst, constCache: b.constCache, rootScope };
  const render = (name, vars) => {
    const nodes = b.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars, parent: rootScope }, ctx, 0, out);
    return out.join('');
  };
  for (let si = 0; si < b.sources.length; si++) {
    const s = b.sources[si];
    const page = {
      ...s.card,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: s.newer ? s.newer.link : null,
      older: s.older ? s.older.link : null,
      is_post: s.post,
    };
    b.output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let ti = 0; ti < b.tags.length; ti++) {
    const t = b.tags[ti];
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) },
    });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (let fi = 0; fi < b.statics.length; fi++) {
    const f = b.statics[fi];
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  let pageCount = 0;
  for (let si = 0; si < b.sources.length; si++) if (!b.sources[si].post) pageCount++;
  lines.push(`built ${pageCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return b.output;
}

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...). */
function isScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
