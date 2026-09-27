import { NextRequest, NextResponse } from "next/server";
import { getBook } from "@/lib/repo";

export const runtime = "nodejs";

/**
 * Genre suggestions from title/author/tags keywords.
 * (Keyword heuristic — clearly labeled as such, not an LLM.)
 */
const genreKeywords: Record<string, string[]> = {
  fantasy: ["magic", "dragon", "wizard", "fantasy", "quest", "realm", "sorcerer", "elf", "dwarf", "enchant", "spell", "witch", "fairy"],
  scifi: ["space", "alien", "future", "robot", "galaxy", "cyberpunk", "dystopia", "android", "starship", "planet", "mars", "time travel"],
  mystery: ["detective", "murder", "crime", "investigation", "thriller", "suspect", "clue", "mystery", "solve", "case"],
  romance: ["love", "heart", "passion", "romance", "relationship", "kiss", "wedding", "couple", "romantic"],
  horror: ["horror", "terror", "haunted", "ghost", "nightmare", "dark", "demon", "vampire", "zombie", "curse"],
  biography: ["life", "autobiography", "memoir", "biography", "story of", "journey", "years"],
  history: ["history", "historical", "war", "ancient", "century", "empire", "civilization", "revolution"],
  business: ["business", "entrepreneur", "startup", "marketing", "leadership", "strategy", "management", "finance"],
  selfhelp: ["self-help", "motivation", "success", "habit", "mindset", "productivity", "happiness", "growth"],
  science: ["science", "physics", "biology", "chemistry", "research", "discovery", "theory", "experiment"],
  philosophy: ["philosophy", "ethics", "moral", "meaning", "existence", "thought", "wisdom"],
  poetry: ["poem", "poetry", "verse", "sonnet", "rhyme", "lyric"],
  cooking: ["recipe", "cooking", "food", "kitchen", "chef", "cuisine", "ingredient"],
  travel: ["travel", "journey", "adventure", "explore", "destination", "wanderlust"],
  children: ["children", "kids", "bedtime", "picture book", "young reader"],
};

export async function POST(req: NextRequest) {
  try {
    let body: { bookId?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ success: false, message: "Malformed request" }, { status: 400 });
    }

    if (!body.bookId) {
      return NextResponse.json({ success: false, message: "bookId required" }, { status: 400 });
    }

    const book = await getBook(body.bookId);
    if (!book) {
      return NextResponse.json({ success: false, message: "Book not found" }, { status: 404 });
    }

    const text = `${book.title} ${book.author ?? ""} ${book.tags ?? ""}`.toLowerCase();
    const suggestions: { genre: string; confidence: number; matchedKeywords: string[] }[] = [];

    for (const [genre, keywords] of Object.entries(genreKeywords)) {
      const matched = keywords.filter((k) => text.includes(k));
      if (matched.length > 0) {
        suggestions.push({
          genre,
          confidence: Math.min(100, Math.round((matched.length / keywords.length) * 200)),
          matchedKeywords: matched,
        });
      }
    }

    suggestions.sort((a, b) => b.confidence - a.confidence);

    return NextResponse.json({
      success: true,
      suggestions,
      note: "Keyword-based suggestions — select the genres that apply to confirm.",
    });
  } catch (error) {
    console.error("Genre suggestion error:", error);
    return NextResponse.json({ success: false, message: "Failed to suggest genres" }, { status: 500 });
  }
}
