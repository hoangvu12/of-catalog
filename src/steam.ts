import type { SteamAppData } from "./types";
import {
  cleanTitle,
  fetchJson,
  mapPool,
  normalizeTitle,
  sleep,
} from "./util";

interface StoreSearchResponse {
  items?: Array<{ id?: number; name?: string; type?: string }>;
}

type AppDetailsResponse = Record<
  string,
  {
    success?: boolean;
    data?: Record<string, unknown>;
  }
>;

interface StoreTaxonomy {
  tags: Map<number, string>;
  categories: Map<number, string>;
}

interface StoreBrowseResponse {
  response?: { store_items?: Array<Record<string, unknown>> };
}

const LANGUAGE_NAMES: Record<number, string> = {
  0: "English",
  1: "German",
  2: "French",
  3: "Italian",
  4: "Korean",
  5: "Spanish - Spain",
  6: "Simplified Chinese",
  7: "Traditional Chinese",
  8: "Russian",
  9: "Thai",
  10: "Japanese",
  11: "Portuguese - Portugal",
  12: "Polish",
  13: "Danish",
  14: "Dutch",
  15: "Finnish",
  16: "Norwegian",
  17: "Swedish",
  18: "Hungarian",
  19: "Czech",
  20: "Romanian",
  21: "Turkish",
  22: "Arabic",
  23: "Portuguese - Brazil",
  24: "Bulgarian",
  25: "Greek",
  26: "Ukrainian",
  27: "Vietnamese",
  28: "Spanish - Latin America",
  29: "Indonesian",
};

const GENRE_NAMES = new Set([
  "Action",
  "Adventure",
  "Casual",
  "Free to Play",
  "Indie",
  "Massively Multiplayer",
  "Racing",
  "RPG",
  "Simulation",
  "Sports",
  "Strategy",
]);

async function fetchStoreTaxonomy(): Promise<StoreTaxonomy> {
  const [tagBody, categoryBody] = await Promise.all([
    fetchJson<{ response?: { tags?: Array<{ tagid?: number; name?: string }> } }>(
      "https://api.steampowered.com/IStoreService/GetTagList/v1/?language=english",
    ),
    fetchJson<{
      response?: {
        categories?: Array<{ categoryid?: number; display_name?: string }>;
      };
    }>(
      "https://api.steampowered.com/IStoreBrowseService/GetStoreCategories/v1/?language=english",
    ),
  ]);
  return {
    tags: new Map(
      (tagBody.response?.tags ?? []).flatMap((tag) =>
        tag.tagid && tag.name ? [[tag.tagid, tag.name] as const] : [],
      ),
    ),
    categories: new Map(
      (categoryBody.response?.categories ?? []).flatMap((category) =>
        category.categoryid && category.display_name
          ? [[category.categoryid, category.display_name] as const]
          : [],
      ),
    ),
  };
}

function storeAsset(assetPath: unknown): string | undefined {
  if (typeof assetPath !== "string" || !assetPath) return undefined;
  if (assetPath.startsWith("http")) return assetPath;
  return `https://shared.fastly.steamstatic.com/store_item_assets/${assetPath}`;
}

function assetFromFormat(format: unknown, filename: unknown): string | undefined {
  if (typeof format !== "string" || typeof filename !== "string") return undefined;
  return storeAsset(format.replace("${FILENAME}", filename));
}

function trailerAsset(format: unknown, filename: unknown): string | undefined {
  if (typeof filename !== "string" || !filename) return undefined;
  const query = typeof format === "string" ? format.match(/\?[^?]+$/)?.[0] ?? "" : "";
  return `https://video.fastly.steamstatic.com/store_trailers/${filename}${query}`;
}

function normalizeStoreItem(
  item: Record<string, unknown>,
  taxonomy: StoreTaxonomy,
): SteamAppData | null {
  const appId = Number(item.appid ?? item.id);
  if (!Number.isInteger(appId) || appId <= 0 || Number(item.success) !== 1) return null;

  const basic = (item.basic_info ?? {}) as {
    short_description?: unknown;
    developers?: Array<{ name?: unknown }>;
    publishers?: Array<{ name?: unknown }>;
  };
  const assets = (item.assets ?? {}) as Record<string, unknown>;
  const assetFormat = assets.asset_url_format;
  const release = (item.release ?? {}) as { steam_release_date?: unknown };
  const platforms = (item.platforms ?? {}) as {
    windows?: unknown;
    mac?: unknown;
    steamos_linux?: unknown;
  };
  const categories = (item.categories ?? {}) as Record<string, unknown>;
  const categoryIds = [
    categories.supported_player_categoryids,
    categories.feature_categoryids,
    categories.controller_categoryids,
  ]
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .map(Number)
    .filter((id, i, all) => Number.isInteger(id) && all.indexOf(id) === i);
  const features = categoryIds
    .map((id) => taxonomy.categories.get(id))
    .filter((name): name is string => !!name);

  const tagNames = (Array.isArray(item.tagids) ? item.tagids : [])
    .map(Number)
    .map((id) => taxonomy.tags.get(id))
    .filter((name): name is string => !!name);
  const genres = tagNames.filter((name) => GENRE_NAMES.has(name)).slice(0, 6);

  const screenshotBlock = (item.screenshots ?? {}) as {
    all_ages_screenshots?: Array<{ filename?: unknown }>;
    mature_content_screenshots?: Array<{ filename?: unknown }>;
  };
  const screenshots = [
    ...(screenshotBlock.all_ages_screenshots ?? []),
    ...(screenshotBlock.mature_content_screenshots ?? []),
  ].flatMap((shot) => {
    const full = storeAsset(shot.filename);
    if (!full) return [];
    return [{ thumb: full.replace(/\.jpg(?=\?|$)/, ".600x338.jpg"), full }];
  });

  const trailerBlock = (item.trailers ?? {}) as {
    highlights?: Array<Record<string, unknown>>;
    other_trailers?: Array<Record<string, unknown>>;
  };
  const movie = trailerBlock.highlights?.[0] ?? trailerBlock.other_trailers?.[0];
  let trailer: SteamAppData["trailer"];
  if (movie) {
    const adaptive = Array.isArray(movie.adaptive_trailers)
      ? (movie.adaptive_trailers as Array<{ cdn_path?: unknown; encoding?: unknown }>)
      : [];
    const micro = Array.isArray(movie.microtrailer)
      ? (movie.microtrailer as Array<{ filename?: unknown; type?: unknown }>)
      : [];
    const hls = trailerAsset(
      movie.trailer_url_format,
      adaptive.find((entry) => entry.encoding === "hls_h264")?.cdn_path,
    );
    const mp4 = trailerAsset(
      movie.trailer_url_format,
      micro.find((entry) => entry.type === "video/mp4")?.filename,
    );
    if (hls || mp4) {
      trailer = {
        thumb: assetFromFormat(movie.trailer_url_format, movie.screenshot_medium) ?? "",
        hls,
        mp4,
        name: typeof movie.trailer_name === "string" ? movie.trailer_name : undefined,
      };
    }
  }

  const languageEntries = Array.isArray(item.supported_languages)
    ? (item.supported_languages as Array<{ elanguage?: unknown; supported?: unknown }>)
    : [];
  const languages = languageEntries.flatMap((entry) => {
    if (entry.supported === false) return [];
    const name = LANGUAGE_NAMES[Number(entry.elanguage)];
    return name ? [name] : [];
  });
  const releaseSeconds = Number(release.steam_release_date);
  const releaseDate = releaseSeconds > 0
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(releaseSeconds * 1000))
    : undefined;
  const controllerIds = Array.isArray(categories.controller_categoryids)
    ? categories.controller_categoryids.map(Number)
    : [];
  const reviews = (item.reviews ?? {}) as {
    summary_filtered?: { review_count?: unknown };
  };
  const reviewCount = Number(reviews.summary_filtered?.review_count);

  return {
    appId,
    name: typeof item.name === "string" ? item.name : undefined,
    description:
      typeof basic.short_description === "string" ? basic.short_description : undefined,
    developer:
      typeof basic.developers?.[0]?.name === "string" ? basic.developers[0].name : undefined,
    publisher:
      typeof basic.publishers?.[0]?.name === "string" ? basic.publishers[0].name : undefined,
    releaseDate,
    genres,
    features,
    heroImage: assetFromFormat(assetFormat, assets.library_hero),
    headerImage: assetFromFormat(assetFormat, assets.header),
    screenshots,
    trailer,
    platformSupport: {
      windows: !!platforms.windows,
      mac: !!platforms.mac,
      linux: !!platforms.steamos_linux,
    },
    controllerSupport: controllerIds.includes(28)
      ? "full"
      : controllerIds.includes(18)
        ? "partial"
        : undefined,
    recommendationsTotal: reviewCount > 0 ? reviewCount : undefined,
    languages,
    contentDescriptors: [],
    fetchedAt: new Date().toISOString(),
  };
}

function searchTerms(title: string): string[] {
  const base = cleanTitle(title);
  const terms = [base];
  const stripped = base.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (stripped.length >= 2 && stripped !== base) terms.push(stripped);
  if (base.startsWith("The ")) terms.push(base.slice(4));
  return terms;
}

export async function steamStoreSearch(title: string): Promise<number | null> {
  for (const term of searchTerms(title)) {
    if (term.length < 2) continue;
    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`;
    try {
      const body = await fetchJson<StoreSearchResponse>(url);
      const items = body.items ?? [];
      if (!items.length) continue;

      const want = normalizeTitle(term);

      for (const item of items) {
        if (item.type && item.type !== "app") continue;
        const id = item.id;
        const name = item.name;
        if (!id || !name) continue;
        const n = normalizeTitle(name);
        if (n === want) return id;
      }
    } catch {
      // try next term
    }
    await sleep(200);
  }
  return null;
}

function firstStrArr(d: Record<string, unknown>, key: string): string | undefined {
  const a = d[key];
  if (!Array.isArray(a) || !a.length) return undefined;
  const v = a[0];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function strField(d: Record<string, unknown>, key: string): string | undefined {
  const v = d[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function languagesOf(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const first = raw.split(/<br\s*\/?>/i)[0] ?? raw;
  const text = first.replace(/<[^>]+>/g, "").replace(/\*/g, "");
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !s.toLowerCase().includes("full audio"));
}

function htmlToText(raw: string): string {
  return raw
    .replace(/<\s*(li|br|\/p|\/div|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function requirementsOf(raw: unknown): SteamAppData["requirements"] {
  if (!raw || typeof raw !== "object") return undefined;
  const req = raw as { minimum?: unknown; recommended?: unknown };
  const normalize = (value: unknown) => {
    if (typeof value !== "string") return undefined;
    const text = htmlToText(value)
      .replace(/^(minimum|recommended)\s*:?\s*\n?/i, "")
      .trim();
    return text || undefined;
  };
  const minimum = normalize(req.minimum);
  const recommended = normalize(req.recommended);
  return minimum || recommended ? { minimum, recommended } : undefined;
}

function contentDescriptorsOf(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const descriptors = raw as { notes?: unknown; ids?: unknown };
  if (typeof descriptors.notes === "string" && descriptors.notes.trim()) {
    return [descriptors.notes.trim()];
  }
  const labels = new Map<number, string>([
    [1, "Some Nudity or Sexual Content"],
    [2, "Frequent Violence or Gore"],
    [3, "Adult Only Sexual Content"],
    [4, "Frequent Nudity or Sexual Content"],
    [5, "General Mature Content"],
  ]);
  if (!Array.isArray(descriptors.ids)) return [];
  return descriptors.ids
    .map((id) => labels.get(Number(id)))
    .filter((label): label is string => !!label);
}

function screenshotsOf(raw: unknown): SteamAppData["screenshots"] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const shot = entry as { path_thumbnail?: unknown; path_full?: unknown };
    if (typeof shot.path_full !== "string" || !shot.path_full.startsWith("http")) {
      return [];
    }
    const thumb =
      typeof shot.path_thumbnail === "string" ? shot.path_thumbnail : shot.path_full;
    return [{ thumb, full: shot.path_full }];
  });
}

function trailerOf(raw: unknown): SteamAppData["trailer"] {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const first = raw[0];
  if (!first || typeof first !== "object") return undefined;
  const movie = first as {
    thumbnail?: unknown;
    hls_h264?: unknown;
    mp4?: { max?: unknown; "480"?: unknown };
    name?: unknown;
  };
  const hls =
    typeof movie.hls_h264 === "string" && movie.hls_h264.startsWith("http")
      ? movie.hls_h264
      : undefined;
  const mp4Value = movie.mp4?.max ?? movie.mp4?.["480"];
  const mp4 =
    typeof mp4Value === "string" && mp4Value.startsWith("http")
      ? mp4Value
      : undefined;
  if (!hls && !mp4) return undefined;
  return {
    thumb: typeof movie.thumbnail === "string" ? movie.thumbnail : "",
    mp4,
    hls,
    name: typeof movie.name === "string" ? movie.name : undefined,
  };
}

export function normalizeAppdetails(
  appId: number,
  d: Record<string, unknown>,
): SteamAppData {
  const genres =
    (Array.isArray(d.genres)
      ? d.genres
          .map((g) =>
            g && typeof g === "object" && "description" in g
              ? String((g as { description?: string }).description ?? "")
              : "",
          )
          .filter(Boolean)
      : []) ?? [];

  const features =
    (Array.isArray(d.categories)
      ? d.categories
          .map((c) =>
            c && typeof c === "object" && "description" in c
              ? String((c as { description?: string }).description ?? "")
              : "",
          )
          .filter(Boolean)
      : []) ?? [];

  let metacritic: SteamAppData["metacritic"];
  if (d.metacritic && typeof d.metacritic === "object") {
    const m = d.metacritic as { score?: number; url?: string };
    if (typeof m.score === "number") {
      metacritic = { score: m.score, url: m.url ?? "" };
    }
  }

  let releaseDate: string | undefined;
  if (d.release_date && typeof d.release_date === "object") {
    const r = d.release_date as { coming_soon?: boolean; date?: string };
    if (!r.coming_soon && r.date?.trim()) releaseDate = r.date.trim();
  }

  let platformSupport: SteamAppData["platformSupport"];
  if (d.platforms && typeof d.platforms === "object") {
    const p = d.platforms as {
      windows?: boolean;
      mac?: boolean;
      linux?: boolean;
    };
    platformSupport = {
      windows: !!p.windows,
      mac: !!p.mac,
      linux: !!p.linux,
    };
    if (!platformSupport.windows && !platformSupport.mac && !platformSupport.linux) {
      platformSupport = undefined;
    }
  }

  const ctrl = strField(d, "controller_support");
  const controllerSupport =
    ctrl === "full" || ctrl === "partial" ? ctrl : undefined;

  const achievements =
    d.achievements && typeof d.achievements === "object"
      ? (d.achievements as { total?: number }).total
      : undefined;
  const recommendations =
    d.recommendations && typeof d.recommendations === "object"
      ? (d.recommendations as { total?: number }).total
      : undefined;

  const header = strField(d, "header_image");
  const hero = strField(d, "background_raw") ?? strField(d, "background");
  const website = strField(d, "website");

  return {
    appId,
    name: strField(d, "name"),
    description: strField(d, "short_description"),
    developer: firstStrArr(d, "developers"),
    publisher: firstStrArr(d, "publishers"),
    releaseDate,
    genres,
    features,
    metacritic,
    heroImage: hero?.startsWith("http") ? hero : undefined,
    headerImage: header?.startsWith("http") ? header : undefined,
    screenshots: screenshotsOf(d.screenshots),
    trailer: trailerOf(d.movies),
    platformSupport,
    controllerSupport,
    achievementsTotal:
      typeof achievements === "number" && achievements > 0
        ? achievements
        : undefined,
    recommendationsTotal:
      typeof recommendations === "number" && recommendations > 0
        ? recommendations
        : undefined,
    languages: languagesOf(d.supported_languages),
    requirements: requirementsOf(d.pc_requirements),
    contentDescriptors: contentDescriptorsOf(d.content_descriptors),
    website: website?.startsWith("http") ? website : undefined,
    fetchedAt: new Date().toISOString(),
  };
}

export async function steamAppdetails(appId: number): Promise<SteamAppData | null> {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&l=en&cc=US`;
  try {
    const body = await fetchJson<AppDetailsResponse>(url);
    const entry = body[String(appId)];
    if (!entry?.success || !entry.data) return null;
    return normalizeAppdetails(appId, entry.data);
  } catch {
    return null;
  }
}

export async function resolveAppIds(
  titles: Array<{ key: string; title: string }>,
  existing: Map<string, number>,
  opts?: {
    concurrency?: number;
    delayMs?: number;
    onProgress?: (done: number, total: number, title: string, id: number | null) => void;
  },
): Promise<Map<string, number | null>> {
  const concurrency = opts?.concurrency ?? 2;
  const delayMs = opts?.delayMs ?? 350;
  const result = new Map<string, number | null>();

  const pending = titles.filter((t) => {
    if (existing.has(t.key)) {
      result.set(t.key, existing.get(t.key)!);
      return false;
    }
    return true;
  });

  await mapPool(pending, concurrency, async (t, i) => {
    if (i > 0) await sleep(delayMs);
    const id = await steamStoreSearch(t.title);
    result.set(t.key, id);
    opts?.onProgress?.(i + 1, pending.length, t.title, id);
    return id;
  });

  return result;
}

export async function fetchSteamAppDataMany(
  appIds: number[],
  existing: Record<string, SteamAppData>,
  opts?: {
    concurrency?: number;
    delayMs?: number;
    refreshOlderThanDays?: number;
    onProgress?: (done: number, total: number, appId: number) => void;
  },
): Promise<Record<string, SteamAppData>> {
  const delayMs = opts?.delayMs ?? 500;
  const maxAgeMs = (opts?.refreshOlderThanDays ?? 30) * 86400_000;
  const now = Date.now();
  const out: Record<string, SteamAppData> = { ...existing };

  const need = appIds.filter((id) => {
    const prev = out[String(id)];
    if (!prev) return true;
    const age = now - Date.parse(prev.fetchedAt);
    return !Number.isFinite(age) || age > maxAgeMs;
  });

  if (!need.length) return out;

  const taxonomy = await fetchStoreTaxonomy();
  const batchSize = 40;
  let done = 0;
  for (let start = 0; start < need.length; start += batchSize) {
    const ids = need.slice(start, start + batchSize);
    const input = {
      ids: ids.map((appid) => ({ appid })),
      context: { language: "english", country_code: "US" },
      data_request: {
        include_basic_info: true,
        include_assets: true,
        include_release: true,
        include_platforms: true,
        include_screenshots: true,
        include_trailers: true,
        include_reviews: true,
        include_supported_languages: true,
        include_tag_count: 20,
      },
    };
    const url =
      "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=" +
      encodeURIComponent(JSON.stringify(input));
    let body: StoreBrowseResponse | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        body = await fetchJson<StoreBrowseResponse>(url);
        break;
      } catch {
        await sleep(1000 * 2 ** attempt);
      }
    }
    for (const item of body?.response?.store_items ?? []) {
      const normalized = normalizeStoreItem(item, taxonomy);
      if (!normalized) continue;
      const previous = out[String(normalized.appId)];
      // Preserve fields only available from legacy appdetails if already cached.
      out[String(normalized.appId)] = {
        ...normalized,
        metacritic: previous?.metacritic,
        achievementsTotal: previous?.achievementsTotal,
        requirements: previous?.requirements,
        contentDescriptors:
          previous?.contentDescriptors?.length
            ? previous.contentDescriptors
            : normalized.contentDescriptors,
        website: previous?.website,
      };
    }
    done += ids.length;
    opts?.onProgress?.(done, need.length, ids.at(-1)!);
    if (start + batchSize < need.length) await sleep(delayMs);
  }

  return out;
}
