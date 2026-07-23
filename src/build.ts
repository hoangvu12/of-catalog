/**
 * Build OF catalog manifest:
 * 1. Scrape online-fix.me /games/ pages
 * 2. Map titles → Steam AppIDs (reuse prior + overrides)
 * 3. Fetch normalized Steam appdetails for mapped ids
 * 4. Write data/catalog.json + data/unmapped.json
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { scrapeAllListings } from "./scrape-of";
import { fetchSteamAppDataMany, resolveAppIds } from "./steam";
import type {
  CatalogManifest,
  OfGame,
  Overrides,
  SteamAppData,
  UnmappedEntry,
} from "./types";

const ROOT = path.resolve(import.meta.dir, "..");
const DATA = path.join(ROOT, "data");
const CATALOG_PATH = path.join(DATA, "catalog.json");
const UNMAPPED_PATH = path.join(DATA, "unmapped.json");
const OVERRIDES_PATH = path.join(DATA, "overrides.json");
const MAPPING_VERSION = 2;
const STEAM_DATA_VERSION = 2;

function argFlag(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  return process.argv[i + 1];
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function main() {
  const scrapeOnly = argFlag("--scrape-only");
  const skipSteamDetails = argFlag("--skip-steam-details");
  const maxPages = argValue("--max-pages")
    ? Number(argValue("--max-pages"))
    : undefined;

  await mkdir(DATA, { recursive: true });

  const prev = await readJson<CatalogManifest | null>(CATALOG_PATH, null);
  const overridesRaw = await readJson<Overrides>(OVERRIDES_PATH, {});
  const overrides: Overrides = Object.fromEntries(
    Object.entries(overridesRaw).filter(([k]) => /^\d+$/.test(k)),
  );

  console.log("→ scraping Online-Fix listing…");
  const scraped = await scrapeAllListings({
    delayMs: 350,
    maxPages: Number.isFinite(maxPages) ? maxPages : undefined,
    onPage: (page, max, count) => {
      console.log(`  page ${page}/${max ?? "?"} → ${count} games`);
    },
  });
  console.log(`✓ scraped ${scraped.length} games`);

  // Carry forward prior steamAppId by OF id
  const byPrevId = new Map<string, OfGame>();
  if (prev?.mappingVersion === MAPPING_VERSION) {
    for (const g of prev.games) byPrevId.set(g.id, g);
  }

  const games: OfGame[] = scraped.map((g) => {
    const old = byPrevId.get(g.id);
    return {
      ...g,
      steamAppId: old?.steamAppId,
    };
  });

  // Apply overrides first
  for (const g of games) {
    if (Object.prototype.hasOwnProperty.call(overrides, g.id)) {
      const v = overrides[g.id];
      g.steamAppId = v === null ? undefined : v;
    }
  }

  if (scrapeOnly) {
    const manifest = buildManifest(games, prev?.steam ?? {}, "scrape-only");
    await writeOutputs(manifest, []);
    console.log("done (scrape-only)");
    return;
  }

  // Resolve missing AppIDs
  const existingMap = new Map<string, number>();
  for (const g of games) {
    if (g.steamAppId) existingMap.set(g.id, g.steamAppId);
  }

  const needResolve = games
    .filter((g) => !g.steamAppId && overrides[g.id] !== null)
    .map((g) => ({ key: g.id, title: g.titleClean || g.title }));

  console.log(
    `→ resolving Steam AppIDs (${needResolve.length} unmapped, ${existingMap.size} cached)…`,
  );

  const resolved = await resolveAppIds(needResolve, existingMap, {
    concurrency: 2,
    delayMs: 400,
    onProgress: (done, total, title, id) => {
      if (done % 10 === 0 || done === total || id) {
        console.log(
          `  map ${done}/${total}: ${title.slice(0, 50)} → ${id ?? "—"}`,
        );
      }
    },
  });

  for (const g of games) {
    if (Object.prototype.hasOwnProperty.call(overrides, g.id)) continue;
    const id = resolved.get(g.id);
    if (typeof id === "number") g.steamAppId = id;
  }

  let steam: Record<string, SteamAppData> =
    prev?.steamDataVersion === STEAM_DATA_VERSION ? { ...prev.steam } : {};

  if (!skipSteamDetails) {
    const appIds = [
      ...new Set(
        games
          .map((g) => g.steamAppId)
          .filter((x): x is number => typeof x === "number" && x > 0),
      ),
    ];
    console.log(`→ fetching Steam app data (${appIds.length} apps)…`);
    steam = await fetchSteamAppDataMany(appIds, steam, {
      concurrency: 2,
      delayMs: 450,
      refreshOlderThanDays: 21,
      onProgress: (done, total, appId) => {
        if (done % 20 === 0 || done === total) {
          console.log(`  steam ${done}/${total} (last ${appId})`);
        }
      },
    });
    console.log(`✓ steam records: ${Object.keys(steam).length}`);
  }

  const unmapped: UnmappedEntry[] = games
    .filter((g) => !g.steamAppId)
    .map((g) => ({
      id: g.id,
      title: g.title,
      titleClean: g.titleClean,
      originPath: g.originPath,
      reason: overrides[g.id] === null ? "override:null" : "storesearch:miss",
    }));

  const manifest = buildManifest(games, steam);
  await writeOutputs(manifest, unmapped);

  console.log("── summary ──");
  console.log(`  total:     ${manifest.stats.total}`);
  console.log(`  mapped:    ${manifest.stats.mapped}`);
  console.log(`  unmapped:  ${manifest.stats.unmapped}`);
  console.log(`  steam:     ${manifest.stats.steamRecords}`);
  console.log(`  wrote:     ${CATALOG_PATH}`);
}

function buildManifest(
  games: OfGame[],
  steam: Record<string, SteamAppData>,
  _note?: string,
): CatalogManifest {
  // Only keep steam entries referenced by games
  const used = new Set(
    games.map((g) => g.steamAppId).filter((x): x is number => !!x),
  );
  const steamOut: Record<string, SteamAppData> = {};
  for (const id of used) {
    const s = steam[String(id)];
    if (s) steamOut[String(id)] = s;
  }

  const mapped = games.filter((g) => g.steamAppId).length;
  return {
    version: 1,
    mappingVersion: MAPPING_VERSION,
    steamDataVersion: STEAM_DATA_VERSION,
    updatedAt: new Date().toISOString(),
    source: "https://online-fix.me/games/",
    games,
    steam: steamOut,
    stats: {
      total: games.length,
      mapped,
      unmapped: games.length - mapped,
      steamRecords: Object.keys(steamOut).length,
    },
  };
}

async function writeOutputs(
  manifest: CatalogManifest,
  unmapped: UnmappedEntry[],
) {
  await writeFile(CATALOG_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const browse = {
    version: manifest.version,
    mappingVersion: manifest.mappingVersion,
    updatedAt: manifest.updatedAt,
    source: manifest.source,
    games: manifest.games,
    stats: manifest.stats,
  };
  await writeFile(
    path.join(DATA, "browse.json"),
    JSON.stringify(browse) + "\n",
    "utf8",
  );
  await writeFile(
    UNMAPPED_PATH,
    JSON.stringify(
      { updatedAt: manifest.updatedAt, count: unmapped.length, items: unmapped },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  // Slim index for clients that only need id → appId
  const index = {
    version: 1 as const,
    updatedAt: manifest.updatedAt,
    map: Object.fromEntries(
      manifest.games
        .filter((g) => g.steamAppId)
        .map((g) => [g.id, g.steamAppId!]),
    ),
  };
  await writeFile(
    path.join(DATA, "appid-index.json"),
    JSON.stringify(index) + "\n",
    "utf8",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
