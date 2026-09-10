// src/tools/matchmaker.ts

export interface ToolSuggestion {
  name: string;
  description: string;
  version: string;
  npmUrl: string;
  weeklyDownloads: number | null;
  lastPublished: string;
  qualityScore: number;
  maintenanceScore: number;
}

interface NpmSearchResponse {
  objects: {
    package: {
      name: string;
      description?: string;
      version: string;
      date: string;
      links: { npm: string };
    };
    score: {
      detail: { quality: number; maintenance: number };
    };
    searchScore: number;
  }[];
}

/**
 * Section 16 Tool Matchmaker (Node 3a/6). Live npm search, not a curated
 * list — a hardcoded list goes stale the day you write it. Filters out
 * anything that looks abandoned (no publish in >2 years) or low-quality
 * per npm's own scoring, since a match nobody maintains is worse than no
 * suggestion. This NEVER installs anything. It returns suggestions; the
 * caller is responsible for displaying them and asking before touching
 * package.json (Section 20 checkpoint — same as everything else advisory).
 */
export async function suggestTools(
  purpose: string,
  maxResults = 3
): Promise<ToolSuggestion[]> {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(purpose)}&size=10`;

  let json: NpmSearchResponse;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  [matchmaker] npm search returned ${res.status} — skipping suggestions.`);
      return [];
    }
    json = (await res.json()) as NpmSearchResponse;
  } catch (err) {
    console.warn(`  [matchmaker] npm search failed (${err instanceof Error ? err.message : err}) — skipping suggestions.`);
    return [];
  }

  const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const candidates: ToolSuggestion[] = json.objects
    .map((o) => ({
      name: o.package.name,
      description: o.package.description ?? "(no description)",
      version: o.package.version,
      npmUrl: o.package.links.npm,
      weeklyDownloads: null, // registry search doesn't include this; see fetchDownloads below if you want it
      lastPublished: o.package.date,
      qualityScore: o.score.detail.quality,
      maintenanceScore: o.score.detail.maintenance,
    }))
    // Abandoned or clearly low-quality: filtered out, not just ranked lower.
    // A tool nobody's touched in 2+ years or that scores poorly on npm's
    // own quality metric isn't a real alternative to "reinventing the logic."
    .filter((c) => {
      const age = now - new Date(c.lastPublished).getTime();
      return age < TWO_YEARS_MS && c.qualityScore > 0.3;
    })
    .sort((a, b) => b.maintenanceScore + b.qualityScore - (a.maintenanceScore + a.qualityScore));

  return candidates.slice(0, maxResults);
}

/** Optional follow-up call if you want download counts for the confirm prompt — separate endpoint, so it's opt-in rather than slowing down every search. */
export async function fetchWeeklyDownloads(packageName: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(packageName)}`);
    if (!res.ok) return null;
    const json = (await res.json()) as { downloads?: number };
    return json.downloads ?? null;
  } catch {
    return null;
  }
}

export function formatSuggestions(suggestions: ToolSuggestion[]): string {
  if (suggestions.length === 0) return "  (no vetted matches found — proceeding without a suggestion)";
  return suggestions
    .map(
      (s, i) =>
        `  ${i + 1}. ${s.name}@${s.version} — ${s.description}\n` +
        `     last published ${new Date(s.lastPublished).toDateString()} · ${s.npmUrl}`
    )
    .join("\n");
}
