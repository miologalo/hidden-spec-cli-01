// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: Array<{ old: string; nw: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// File lines (SPEC.md section 3) and three-tier matching (section 5)
// ---------------------------------------------------------------------------

interface FileParts {
  lines: string[];
  br: string;
  endsWithBreak: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', endsWithBreak: false };
  const firstNl = text.indexOf('\n');
  if (firstNl < 0) return { lines: [text], br: '\n', endsWithBreak: false };
  const br = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let endsWithBreak = false;
  if (text.endsWith(br)) {
    parts.pop();
    endsWithBreak = true;
  }
  return { lines: parts, br, endsWithBreak };
}

function joinFile(lines: string[], br: string, endsWithBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (endsWithBreak ? br : '');
}

function leadingWS(s: string): string {
  const m = /^([ \t]*)/.exec(s);
  return m ? m[1]! : '';
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function findOccurrences(fileLines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = 0; i + O.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(fileLines[i + j]!, tier) !== normLine(O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findFirstTier(fileLines: string[], O: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = findOccurrences(fileLines, O, t);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

type BodyItem = { kind: 'ctx' | 'old' | 'new'; text: string };

function oldLinesOf(items: BodyItem[]): string[] {
  return items.filter((i) => i.kind === 'ctx' || i.kind === 'old').map((i) => i.text);
}

function newItemsOf(items: BodyItem[]): BodyItem[] {
  return items.filter((i) => i.kind === 'ctx' || i.kind === 'new');
}

/**
 * Build the lines that replace the matched region. Context lines are written as the file's own
 * matched lines; at tier 2 every other line of N is re-indented from O's first line to the file's
 * first matched line.
 */
function buildReplacement(items: BodyItem[], fileLines: string[], matchPos: number, tier: number): string[] {
  const oItems = items.filter((i) => i.kind === 'ctx' || i.kind === 'old');
  const nItems = newItemsOf(items);
  const oCtxIndices: number[] = [];
  oItems.forEach((it, idx) => {
    if (it.kind === 'ctx') oCtxIndices.push(idx);
  });
  const P = oItems.length > 0 ? leadingWS(oItems[0]!.text) : '';
  const F = fileLines.length > matchPos ? leadingWS(fileLines[matchPos]!) : '';
  const result: string[] = [];
  let ctxK = 0;
  for (const it of nItems) {
    if (it.kind === 'ctx') {
      const oIdx = oCtxIndices[ctxK]!;
      ctxK++;
      result.push(fileLines[matchPos + oIdx]!);
    } else {
      let t = it.text;
      if (tier === 2 && t !== '' && !/^[ \t]*$/.test(t) && t.startsWith(P)) {
        t = F + t.slice(P.length);
      }
      result.push(t);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: string[];
  items: BodyItem[];
  noNewlineAtEnd: boolean;
  lastPlusNoNl: boolean;
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  hasDashPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isNewFile: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

function parseDiffGit(line: string): { x: string; y: string } | null {
  const rest = line.slice('diff --git '.length);
  const m = /^a\/(\S+) b\/(\S+)\s*$/.exec(rest);
  if (!m) return null;
  return { x: m[1]!, y: m[2]! };
}

function parseDashPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunkHeader(line: string): { a: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return { a: Number(m[1]) };
}

function finishHunkBody(h: Hunk): void {
  while (h.body.length > 0 && h.body[h.body.length - 1] === '') h.body.pop();
  h.items = [];
  for (const bl of h.body) {
    if (bl.startsWith(' ')) h.items.push({ kind: 'ctx', text: bl.slice(1) });
    else if (bl.startsWith('-')) h.items.push({ kind: 'old', text: bl.slice(1) });
    else if (bl.startsWith('+')) h.items.push({ kind: 'new', text: bl.slice(1) });
    else if (bl === '') h.items.push({ kind: 'ctx', text: '' });
  }
  let lastCtxNew = -1;
  let lastPlus = -1;
  for (let k = h.body.length - 1; k >= 0; k--) {
    const bl = h.body[k]!;
    if (lastCtxNew < 0 && (bl.startsWith(' ') || bl.startsWith('+') || bl === '')) lastCtxNew = k;
    if (lastPlus < 0 && bl.startsWith('+')) lastPlus = k;
    if (lastCtxNew >= 0 && lastPlus >= 0) break;
  }
  h.noNewlineAtEnd = lastCtxNew >= 0 && lastCtxNew + 1 < h.body.length && h.body[lastCtxNew + 1]!.startsWith('\\');
  h.lastPlusNoNl = lastPlus >= 0 && lastPlus + 1 < h.body.length && h.body[lastPlus + 1]!.startsWith('\\');
}

function resolveSectionPaths(s: Section): { old: string | null; nw: string | null } {
  if (s.hasDashPair) return { old: s.dashOld, nw: s.dashNew };
  if (s.renameFrom !== null || s.renameTo !== null) {
    return { old: s.renameFrom ?? s.gitOld, nw: s.renameTo ?? s.gitNew };
  }
  return { old: s.gitOld, nw: s.gitNew };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let curHunk: Hunk | null = null;
  const finishHunk = () => {
    if (curHunk) {
      finishHunkBody(curHunk);
      curHunk = null;
    }
  };
  const startSection = (gitOld: string | null, gitNew: string | null): Section => {
    finishHunk();
    const s: Section = {
      gitOld,
      gitNew,
      dashOld: null,
      dashNew: null,
      hasDashPair: false,
      renameFrom: null,
      renameTo: null,
      isNewFile: false,
      isDeleted: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const ln = i + 1;
    if (line.startsWith('diff --git ')) {
      const dg = parseDiffGit(line);
      if (!dg) throw new Exit2(`error: parse ${ln}`);
      startSection(dg.x, dg.y);
      i++;
      continue;
    }
    if (curHunk !== null) {
      if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) {
        finishHunk();
        const s = startSection(null, null);
        const op = parseDashPath(line);
        const np = parseDashPath(lines[i + 1]!);
        s.dashOld = op === '/dev/null' ? null : op;
        s.dashNew = np === '/dev/null' ? null : np;
        s.hasDashPair = true;
        i += 2;
        continue;
      }
      if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        curHunk.body.push(line);
        i++;
        continue;
      }
      finishHunk();
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      const h = parseHunkHeader(line);
      if (!h) throw new Exit2(`error: parse ${ln}`);
      curHunk = { a: h.a, body: [], items: [], noNewlineAtEnd: false, lastPlusNoNl: false };
      cur.hunks.push(curHunk);
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) {
        if (cur !== null && cur.hunks.length === 0 && !cur.hasDashPair) {
          const op = parseDashPath(line);
          const np = parseDashPath(lines[i + 1]!);
          cur.dashOld = op === '/dev/null' ? null : op;
          cur.dashNew = np === '/dev/null' ? null : np;
          cur.hasDashPair = true;
        } else {
          const s = startSection(null, null);
          const op = parseDashPath(line);
          const np = parseDashPath(lines[i + 1]!);
          s.dashOld = op === '/dev/null' ? null : op;
          s.dashNew = np === '/dev/null' ? null : np;
          s.hasDashPair = true;
        }
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) {
        throw new Exit2(`error: parse ${ln + 1}`);
      }
      i++;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isNewFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDeleted = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  finishHunk();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function unifiedSectionEdit(s: Section, strict: boolean): Edit {
  const { old, nw } = resolveSectionPaths(s);
  const isCreate = old === null || s.isNewFile;
  const isDelete = !isCreate && (nw === null || s.isDeleted);
  const isMove = !isCreate && !isDelete && old !== nw;
  return (tree: Tree) => {
    if (isCreate) {
      const p = nw!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const outLines: string[] = [];
      let lastPlusNoNl = false;
      for (const h of s.hunks) {
        for (const it of h.items) if (it.kind === 'new') outLines.push(it.text);
      }
      for (let k = s.hunks.length - 1; k >= 0; k--) {
        const h = s.hunks[k]!;
        if (h.items.some((it) => it.kind === 'new')) {
          lastPlusNoNl = h.lastPlusNoNl;
          break;
        }
      }
      const content = outLines.length === 0 ? '' : outLines.join('\n') + (lastPlusNoNl ? '' : '\n');
      tree.now.set(p, content);
      return;
    }
    if (isDelete) {
      const p = old!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (isMove) {
      const op = old!;
      const np = nw!;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const after = applyHunks(before, s.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, after);
      tree.moves.push({ old: op, nw: np });
      return;
    }
    const p = old!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const after = applyHunks(before, s.hunks, strict, p);
    tree.now.set(p, after);
  };
}

/** Apply a section's hunks in order to a file's text; returns the new text. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const parts = splitFile(before);
  let fileLines = parts.lines;
  let finalBreak = parts.endsWithBreak;
  let d = 0;
  for (const h of hunks) {
    const O = oldLinesOf(h.items);
    const N = newItemsOf(h.items);
    if (O.length === 0) {
      const idx = Math.max(0, Math.min(h.a + d, fileLines.length));
      const atEnd = idx === fileLines.length;
      fileLines = [...fileLines.slice(0, idx), ...N.map((it) => it.text), ...fileLines.slice(idx)];
      d += N.length;
      if (atEnd) finalBreak = !h.noNewlineAtEnd;
      continue;
    }
    const found = findFirstTier(fileLines, O, strict);
    if (!found) throw new Fail('no-match', path);
    const want = h.a - 1 + d;
    let best = found.positions[0]!;
    let bestDist = Math.abs(best - want);
    for (const pos of found.positions) {
      const dist = Math.abs(pos - want);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const atEnd = best + O.length === fileLines.length;
    const replacement = buildReplacement(h.items, fileLines, best, found.tier);
    fileLines = [...fileLines.slice(0, best), ...replacement, ...fileLines.slice(best + O.length)];
    d += N.length - O.length;
    if (atEnd) finalBreak = !h.noNewlineAtEnd;
  }
  return joinFile(fileLines, parts.br, finalBreak);
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1; // index just after the previous block's >>>>>>> REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    // find the path: nearest line before SEARCH, after prevEnd, not blank, not starting with ```
    let path: string | null = null;
    for (let k = i - 1; k > prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    // find ======= then >>>>>>> REPLACE
    let sep = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        sep = k;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let end = -1;
    for (let k = sep + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const parts = splitFile(before);
    const found = findFirstTier(parts.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const items: BodyItem[] = [
      ...oldLines.map((t): BodyItem => ({ kind: 'old' as const, text: t })),
      ...newLines.map((t): BodyItem => ({ kind: 'new' as const, text: t })),
    ];
    const replacement = buildReplacement(items, parts.lines, pos, found.tier);
    const fileLines = [...parts.lines.slice(0, pos), ...replacement, ...parts.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile(fileLines, parts.br, parts.endsWithBreak));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  body: BodyItem[];
  isEOF: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: string[];
  moveTo: string | null;
  chunks: V4aChunk[];
  updateLine: number;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const sec: V4aSection = { kind: 'add', path, lines: [], moveTo: null, chunks: [], updateLine: i + 1 };
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        if (l.startsWith('+')) {
          sec.lines.push(l.slice(1));
          i++;
        } else if (l === '') {
          sec.lines.push('');
          i++;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      while (sec.lines.length > 0 && sec.lines[sec.lines.length - 1] === '') sec.lines.pop();
      sections.push(sec);
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      const sec: V4aSection = { kind: 'delete', path, lines: [], moveTo: null, chunks: [], updateLine: i + 1 };
      sections.push(sec);
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const sec: V4aSection = { kind: 'update', path, lines: [], moveTo: null, chunks: [], updateLine: i + 1 };
      i++;
      while (i < last && blank(lines[i]!)) i++;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        sec.moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      let curChunk: V4aChunk | null = null;
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        if (l.startsWith('*** End of File')) {
          if (!curChunk) throw new Exit2(`error: parse ${i + 1}`);
          curChunk.isEOF = true;
          sec.chunks.push(curChunk);
          curChunk = null;
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          if (curChunk) sec.chunks.push(curChunk);
          curChunk = { anchor: l.slice(2).trim(), body: [], isEOF: false };
          i++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (!curChunk) curChunk = { anchor: null, body: [], isEOF: false };
          if (l.startsWith(' ')) curChunk.body.push({ kind: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) curChunk.body.push({ kind: 'old', text: l.slice(1) });
          else if (l.startsWith('+')) curChunk.body.push({ kind: 'new', text: l.slice(1) });
          else curChunk.body.push({ kind: 'ctx', text: '' });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (curChunk) sec.chunks.push(curChunk);
      // strip trailing blank (empty context) lines from the last chunk of the section
      const lastChunk = sec.chunks[sec.chunks.length - 1];
      if (lastChunk && !lastChunk.isEOF) {
        while (lastChunk.body.length > 0) {
          const b = lastChunk.body[lastChunk.body.length - 1]!;
          if (b.kind === 'ctx' && b.text === '') lastChunk.body.pop();
          else break;
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) {
        throw new Exit2(`error: parse ${sec.updateLine}`);
      }
      sections.push(sec);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function v4aSectionEdit(s: V4aSection, strict: boolean): Edit {
  return (tree: Tree) => {
    if (s.kind === 'add') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null) {
      if (!safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
      if (tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    }
    const parts = splitFile(before);
    let fileLines = parts.lines;
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        // find first line at or after cursor equal to the anchor at the first tier with one
        let anchorPos = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let k = cursor; k < fileLines.length; k++) {
            if (normLine(fileLines[k]!, t) === normLine(chunk.anchor!, t)) {
              anchorPos = k;
              break;
            }
          }
          if (anchorPos >= 0) break;
        }
        if (anchorPos < 0) throw new Fail('no-match', s.path);
        cursor = anchorPos + 1;
      }
      const O = oldLinesOf(chunk.body);
      const N = newItemsOf(chunk.body);
      if (O.length === 0) {
        const idx = chunk.isEOF ? fileLines.length : cursor;
        fileLines = [...fileLines.slice(0, idx), ...N.map((it) => it.text), ...fileLines.slice(idx)];
        cursor = idx + N.length;
        continue;
      }
      // first occurrence of O at or after the cursor, at the first tier with one
      let found: { tier: number; positions: number[] } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        const pos = findOccurrences(fileLines, O, t).filter((p) => p >= cursor);
        if (pos.length > 0) {
          found = { tier: t, positions: pos };
          break;
        }
      }
      if (!found) throw new Fail('no-match', s.path);
      let pos = found.positions[0]!;
      if (chunk.isEOF) {
        const eofPos = found.positions.find((p) => p + O.length === fileLines.length);
        if (eofPos === undefined) throw new Fail('no-match', s.path);
        pos = eofPos;
      }
      const replacement = buildReplacement(chunk.body, fileLines, pos, found.tier);
      fileLines = [...fileLines.slice(0, pos), ...replacement, ...fileLines.slice(pos + O.length)];
      cursor = pos + replacement.length;
    }
    const after = joinFile(fileLines, parts.br, parts.endsWithBreak);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, after);
      tree.moves.push({ old: s.path, nw: s.moveTo });
    } else {
      tree.now.set(s.path, after);
    }
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  type Change = { sortKey: string; line: string; path: string; now: string | null; remove?: string };
  const changes: Change[] = [];
  const usedAsMove = new Set<string>();
  for (const mv of tree.moves) {
    const oldWas = tree.original(mv.old);
    const oldNow = tree.now.has(mv.old) ? tree.now.get(mv.old)! : tree.original(mv.old);
    const newWas = tree.original(mv.nw);
    const newNow = tree.now.has(mv.nw) ? tree.now.get(mv.nw)! : tree.original(mv.nw);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      changes.push({ sortKey: mv.nw, line: `R ${mv.old} -> ${mv.nw}`, path: mv.nw, now: newNow, remove: mv.old });
      usedAsMove.add(mv.old);
      usedAsMove.add(mv.nw);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (usedAsMove.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changes.push({ sortKey: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, path: p, now });
  }
  changes.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
  const rows = changes.map((c) => c.line);
  for (const c of changes) {
    if (check) continue;
    if (c.now === null) rmSync(c.path, { force: true });
    else {
      if (c.remove !== undefined) rmSync(c.remove, { force: true });
      mkdirSync(dirname(c.path), { recursive: true });
      writeFileSync(c.path, c.now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
