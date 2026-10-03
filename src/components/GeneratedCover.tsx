/**
 * Deterministic typographic cover art for books with no artwork.
 *
 * A small library never has covers for everything; a gray placeholder box
 * makes the grid feel unfinished. Instead we derive a stable duotone from the
 * title+author hash, so every book looks the same every time, and typeset the
 * title like a clothbound spine. Pure presentational — no hooks, no state.
 */

// Candlelit duotones: warm leathers, inks, and shadows. Deliberately NOT a
// rainbow — the palette has to sit next to the app's ember/ink theme.
const PALETTES: [string, string][] = [
  ["#3a2418", "#7a4a24"], // burnt umber
  ["#2c1c22", "#6b3140"], // oxblood
  ["#1d2a24", "#3f5d47"], // forest
  ["#1b2333", "#3d5578"], // midnight
  ["#2a2130", "#5a4470"], // plum
  ["#2b2622", "#6b5b48"], // ash walnut
  ["#22302f", "#41706a"], // verdigris
  ["#33241c", "#8a5a2e"], // amber leather
];

function hashOf(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

interface Props {
  title: string;
  author?: string | null;
  /** Small kicker shown above the title, e.g. "Light Novel". */
  kicker?: string;
}

export default function GeneratedCover({ title, author, kicker }: Props) {
  const h = hashOf(`${title}|${author ?? ""}`);
  const [from, to] = PALETTES[h % PALETTES.length];
  const tilt = ((h >> 5) % 7) - 3; // -3..3deg — a hand-stacked shelf feel

  return (
    <div
      className="gen-cover"
      style={{
        background: `linear-gradient(158deg, ${from} 0%, ${to} 100%)`,
        transform: `rotate(${tilt}deg)`,
      }}
    >
      <span className="gen-cover-spine" style={{ background: `linear-gradient(180deg, ${to}, ${from})` }} />
      <div className="gen-cover-inner">
        {kicker && <div className="gen-cover-kicker">{kicker}</div>}
        <div className="gen-cover-title">{title}</div>
        {author && <div className="gen-cover-author">{author}</div>}
      </div>
      <span className="gen-cover-ornament" style={{ color: "#e0a458" }}>✦</span>
    </div>
  );
}