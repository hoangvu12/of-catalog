# of-catalog

[![Update catalog](https://github.com/hoangvu12/of-catalog/actions/workflows/update.yml/badge.svg)](https://github.com/hoangvu12/of-catalog/actions/workflows/update.yml)

Weekly (and on-demand) scrape of [Online-Fix](https://online-fix.me/games/) listings, mapped to Steam AppIDs + normalized Steam store data.

Consumed by the Ina launcher Online-Fix browse/detail UI so clients don’t need live Steam search on every grid load.

## Outputs (`data/`)

| File | Purpose |
|------|---------|
| `catalog.json` | Full manifest: OF games + embedded normalized Steam data |
| `browse.json` | Small one-request browse manifest (OF rows with mapped AppIDs) |
| `appid-index.json` | Slim `ofId → steamAppId` only |
| `unmapped.json` | Titles that failed Steam search (for manual fix) |
| `overrides.json` | Manual `ofId → steamAppId` (or `null` to skip) |

### `catalog.json` shape

```json
{
  "version": 1,
  "updatedAt": "2026-07-23T00:00:00.000Z",
  "source": "https://online-fix.me/games/",
  "games": [
    {
      "id": "18170",
      "title": "RED FLAG",
      "titleClean": "RED FLAG",
      "originPath": "/games/adventures/18170-red-flag-po-seti.html",
      "coverUrl": "https://online-fix.me/uploads/posts/…",
      "version": "1.2.3",
      "steamAppId": 123456
    }
  ],
  "steam": {
    "123456": {
      "appId": 123456,
      "name": "…",
      "description": "short blurb",
      "developer": "…",
      "publisher": "…",
      "releaseDate": "…",
      "genres": ["Action"],
      "features": ["Single-player"],
      "metacritic": { "score": 80, "url": "…" },
      "headerImage": "https://…",
      "languages": ["English"],
      "fetchedAt": "…"
    }
  },
  "stats": { "total": 0, "mapped": 0, "unmapped": 0, "steamRecords": 0 }
}
```

The Steam map includes the data used by Ina: English name/blurb, developer/publisher, release date, genres/features, art, screenshot and trailer URLs, platforms, controller support, review count, and languages. Metacritic, achievements, PC requirements, content descriptors, and website are optional because Steam's bulk endpoint does not return them.

**Never included:** download hoster URLs, archives, credentials, passwords, or authenticated article data.

## CDN URLs (after push to GitHub)

```
https://raw.githubusercontent.com/hoangvu12/of-catalog/main/data/catalog.json
https://raw.githubusercontent.com/hoangvu12/of-catalog/main/data/browse.json
https://cdn.jsdelivr.net/gh/hoangvu12/of-catalog@main/data/catalog.json
https://cdn.jsdelivr.net/gh/hoangvu12/of-catalog@main/data/appid-index.json
```

## Local

```bash
bun install
bun run build                 # full scrape + map + Steam app data
bun run build -- --max-pages 2
bun run build -- --scrape-only
bun run build -- --skip-steam-details
bun run validate
```

## GitHub Action

- Schedule: weekly Monday 06:00 UTC  
- Manual: Actions → **Update catalog** → Run workflow  

Commits updated `data/*.json` back to `main`.

## Overrides

Edit `data/overrides.json`:

```json
{
  "18170": 123456,
  "99999": null
}
```

`null` forces unmapped (skips auto search). Overrides always win over cache/search.

## Notes

- OF listing is `windows-1251`; scraper decodes accordingly.
- Steam store search is best-effort; expect some misses/wrong hits — fix via overrides.
- Incremental: existing AppIDs and Steam records are reused; Steam data refreshes after ~21 days.
- This repo stores **public listing metadata only**, not archives, passwords, or hoster links.
