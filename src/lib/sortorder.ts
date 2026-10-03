/**
 * Ordering rules for a library that is mostly light novels.
 *
 * The bug this exists to kill: `Intl.Collator` sorts text, so "Volume 10",
 * "Volume 11" and "Volume 12" all land BEFORE "Volume 2", and a shelf of a
 * finished series reads as 1, 10, 11, 12, 2, 3… Nobody types volume numbers by
 * hand, so they get read out of the title instead.
 */

/** Volume markers, ordered by how much we trust them. */
const VOLUME_PATTERNS: RegExp[] = [
  // "Volume 3", "Vol. 3", "Vol 3", "volume_3"
  /\b(?:vol(?:ume)?\.?)\s*(\d{1,4})\b/i,
  // "Book 3" / "Bk. 3" — common in EN light-novel releases
  /\b(?:book|bk\.?)\s*(\d{1,4})\b/i,
  // "#3", "#03"
  /#\s*(\d{1,4})\b/,
  // Japanese/Korean/Chinese light-novel convention: trailing bare number,
  // e.g. "This Gyaru Is Head Over Heels for Me! 3"
  /[\s,;:(\[-]+(\d{1,4})\s*\)?\s*$/,
];

/** Words that mean "this is a sequel number", not a volume number. */
const NOT_VOLUME = /\b(part|pt|chapter|chap|ch|episode|ep|season|series|s)\s*(\d{1,4})\b/i;

/** Numbers that are never a volume number (zero, years, absurd run lengths). */
function isPlausibleVolume(n: number): boolean {
  return n > 0 && n < 1000;
}

export interface SeriesInfo {
  /** Title with the volume marker removed — the series key. */
  series: string;
  /** 1-based volume number, or null when the title carries none. */
  volume: number | null;
}

/**
 * Pull the series name and volume number out of a title.
 *
 * Handles the shapes real light novels use:
 *   "Re:Zero Volume 3"                      → { series: "Re:Zero", volume: 3 }
 *   "Overlord Vol. 10 (light novel)"        → { series: "Overlord", volume: 10 }
 *   "Goblin Slayer #7"                      → { series: "Goblin Slayer", volume: 7 }
 *   "Some Series 12"                        → { series: "Some Series", volume: 12 }
 *   "A Standalone Novel"                    → { series: "A Standalone Novel", volume: null }
 */
export function detectSeries(title: string | null | undefined): SeriesInfo {
  const raw = (title || "").trim();
  if (!raw) return { series: "", volume: null };

  for (const re of VOLUME_PATTERNS) {
    const match = re.exec(raw);
    if (!match) continue;
    const text = match[0];
    const at = match.index;
    // "Part 2", "Chapter 4", "Episode 1" are structure, not series order — and
    // for the bare trailing number the marker word sits *before* the match, so
    // look at the text leading into it too.
    const lead = raw.slice(Math.max(0, at - 12), at);
    if (NOT_VOLUME.test(text) || NOT_VOLUME.test(`${lead} ${match[1]}`)) continue;
    const n = parseInt(match[1], 10);
    if (!isPlausibleVolume(n)) continue;
    const series = raw.replace(text, " ").replace(/\s*[-–—:,(]\s*$/, "").replace(/\s+/g, " ").trim();
    if (!series) continue;
    return { series, volume: n };
  }
  return { series: raw, volume: null };
}

/** Convenience: just the volume number, or null. */
export function detectVolume(title: string | null | undefined): number | null {
  return detectSeries(title).volume;
}

/**
 * Chunk a string into digit / non-digit runs so "vol10" compares as
 * [vol][10] rather than character by character.
 */
function chunks(s: string): (string | number)[] {
  return s
    .toLowerCase()
    .split(/(\d+)/)
    .filter((p) => p !== "")
    .map((p) => (/^\d+$/.test(p) ? Number(p) : p));
}

/**
 * Natural string comparison: digit runs compare numerically, everything else
 * case-insensitively. `s2` (pre-releases) sorts before `s2` base where the
 * name literally says so.
 */
export function naturalCompare(a: string | null | undefined, b: string | null | undefined): number {
  const ca = chunks((a || "").trim());
  const cb = chunks((b || "").trim());
  const n = Math.max(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i];
    const y = cb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x - y;
    } else {
      const xs = String(x);
      const ys = String(y);
      if (xs !== ys) return xs < ys ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Resolve a book to its (series, volume) pair, honouring an explicit series
 * override when one exists but always trying the raw title for the number —
 * a hand-entered series name rarely carries the volume.
 */
export function seriesKeyOf(book: { title: string; series?: string | null }): SeriesInfo {
  const fromTitle = detectSeries(book.title);
  const override = book.series?.trim();
  if (!override) return fromTitle;
  const fromOverride = detectSeries(override);
  return {
    series: fromOverride.volume != null ? fromOverride.series : override,
    volume: fromTitle.volume,
  };
}

/**
 * The order a reader expects: same series together, volume 1 before 2 before
 * 10, and a volume-less book sorted last inside its series.
 */
export function compareBySeriesVolume(
  a: { title: string; series?: string | null },
  b: { title: string; series?: string | null }
): number {
  const ka = seriesKeyOf(a);
  const kb = seriesKeyOf(b);

  const bySeries = naturalCompare(ka.series, kb.series);
  if (bySeries !== 0) return bySeries;

  // Within one series, order by volume; unknown volumes sink to the end.
  if (ka.volume != null && kb.volume != null && ka.volume !== kb.volume) return ka.volume - kb.volume;
  if (ka.volume != null && kb.volume == null) return -1;
  if (ka.volume == null && kb.volume != null) return 1;

  const byTitle = naturalCompare(a.title, b.title);
  if (byTitle !== 0) return byTitle;
  // "Volume 2" vs "Volume 2 (Omnibus)" — shortest label first.
  return (a.title || "").length - (b.title || "").length;
}

/** Sort a copy of a list into series/volume order. */
export function sortBySeriesVolume<T extends { title: string; series?: string | null }>(list: T[]): T[] {
  return [...list].sort(compareBySeriesVolume);
}

/** Group a list into { series, volume, books } runs, in reading order. */
export function groupBySeries<T extends { title: string; series?: string | null }>(
  list: T[]
): { series: string; volume: number | null; book: T }[] {
  return sortBySeriesVolume(list).map((book) => {
    const k = seriesKeyOf(book);
    return { series: k.series, volume: k.volume, book };
  });
}
