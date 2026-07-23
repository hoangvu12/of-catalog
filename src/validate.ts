import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CatalogManifest } from "./types";
import { normalizeTitle } from "./util";

const file = path.resolve(import.meta.dir, "../data/catalog.json");
const manifest = JSON.parse(await readFile(file, "utf8")) as CatalogManifest;
const errors: string[] = [];

if (manifest.version !== 1) errors.push(`unsupported version ${manifest.version}`);
if (manifest.games.length < 1_000) errors.push(`suspicious game count ${manifest.games.length}`);

const ids = new Set<string>();
let mapped = 0;
for (const game of manifest.games) {
  if (ids.has(game.id)) errors.push(`duplicate OF id ${game.id}`);
  ids.add(game.id);
  if (!game.steamAppId) continue;
  mapped++;
  const steam = manifest.steam[String(game.steamAppId)];
  if (!steam) {
    errors.push(`${game.id} ${game.title}: missing Steam record ${game.steamAppId}`);
    continue;
  }
  if (steam.appId !== game.steamAppId) {
    errors.push(`${game.id}: Steam key/appId mismatch ${game.steamAppId}/${steam.appId}`);
  }
  if (!steam.name) errors.push(`${game.id}: Steam record has no name`);
  if (!Array.isArray(steam.screenshots)) errors.push(`${game.id}: screenshots is not an array`);

  // Auto-mapping only accepts exact normalized names. Manual overrides may differ.
  const candidates = [game.titleClean, game.titleClean.replace(/\s*\([^)]*\)\s*$/, "")];
  if (game.titleClean.startsWith("The ")) candidates.push(game.titleClean.slice(4));
  const override = candidates.some(
    (candidate) => normalizeTitle(candidate) === normalizeTitle(steam.name ?? ""),
  );
  if (!override) errors.push(`${game.id}: suspicious mapping ${game.title} -> ${steam.name}`);
}

if (manifest.stats.total !== manifest.games.length) errors.push("stats.total mismatch");
if (manifest.stats.mapped !== mapped) errors.push("stats.mapped mismatch");
if (manifest.stats.unmapped !== manifest.games.length - mapped) {
  errors.push("stats.unmapped mismatch");
}
if (manifest.stats.steamRecords !== Object.keys(manifest.steam).length) {
  errors.push("stats.steamRecords mismatch");
}
if (Object.keys(manifest.steam).length !== mapped) {
  errors.push(`mapped/Steam record mismatch ${mapped}/${Object.keys(manifest.steam).length}`);
}

if (errors.length) {
  console.error(`validation failed (${errors.length}):`);
  for (const error of errors.slice(0, 50)) console.error(`- ${error}`);
  if (errors.length > 50) console.error(`- …and ${errors.length - 50} more`);
  process.exit(1);
}

console.log(
  `valid: ${manifest.games.length} games, ${mapped} mapped, ${manifest.stats.unmapped} unmapped, ${Object.keys(manifest.steam).length} Steam records`,
);
