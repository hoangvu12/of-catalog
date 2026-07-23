import type { OfGame } from "./types";
import {
  SITE,
  absolutize,
  articleIdFromOrigin,
  cleanTitle,
  collapseWs,
  fetchText,
  htmlUnescape,
  originPath,
  sleep,
  stripTags,
} from "./util";

const PAGE_SIZE_HINT = 30;

function attr(block: string, name: string): string | null {
  const re = new RegExp(`${name}=["']([^"']+)["']`, "i");
  const m = block.match(re);
  return m?.[1] ?? null;
}

function captureBetween(s: string, start: string, end: string): string | null {
  const i = s.indexOf(start);
  if (i < 0) return null;
  const rest = s.slice(i + start.length);
  const j = rest.indexOf(end);
  if (j < 0) return null;
  return rest.slice(0, j);
}

function coverFromBlock(block: string): string | undefined {
  const re =
    /(?:data-src|src)=["'](https?:\/\/[^"']+\/uploads\/posts\/[^"']+\.(?:jpg|jpeg|png|webp))["']/i;
  const m = block.match(re);
  if (m?.[1]) return absolutize(m[1]);
  const re2 =
    /(?:data-src|src)=["'](\/uploads\/posts\/[^"']+\.(?:jpg|jpeg|png|webp))["']/i;
  const m2 = block.match(re2);
  return m2?.[1] ? absolutize(m2[1]) : undefined;
}

function versionFromBlock(block: string): string | undefined {
  const patterns = [
    /version[:\s]+([0-9][0-9a-zA-Z.\-_]+)/i,
    /верси[ия][:\s]+([0-9][0-9a-zA-Z.\-_]+)/i,
    /to\s+version\s+([0-9][0-9a-zA-Z.\-_]+)/i,
    /до\s+версии\s+([0-9][0-9a-zA-Z.\-_]+)/i,
  ];
  for (const re of patterns) {
    const m = block.match(re);
    if (m?.[1] && m[1].length >= 2) return m[1].replace(/\.$/, "");
  }
  return undefined;
}

function firstGameHref(block: string): string | null {
  const re = /href=["']([^"']*\/games\/[^"']+\.html)["']/i;
  const m = block.match(re);
  return m?.[1] ?? null;
}

function parseArticleBlock(block: string): OfGame | null {
  const big = block.match(/big-link[^>]*href=["']([^"']+)["']/i)?.[1];
  const href = big || firstGameHref(block);
  if (!href) return null;

  const abs = absolutize(href);
  const id = articleIdFromOrigin(abs);
  if (!id) return null;

  let titleRaw =
    captureBetween(block, '<h2 class="title">', "</h2>") ??
    attr(block, "alt") ??
    "";
  const title = cleanTitle(htmlUnescape(stripTags(titleRaw)));
  if (!title) return null;

  const updatedAt = captureBetween(block, 'datetime="', '"') ?? undefined;
  const description = captureBetween(block, 'preview-text">', "</div>");
  void description;

  return {
    id,
    title,
    titleClean: cleanTitle(title),
    originPath: originPath(abs),
    coverUrl: coverFromBlock(block),
    version: versionFromBlock(block),
    updatedAt: updatedAt || undefined,
  };
}

export function parseListingHtml(html: string): OfGame[] {
  const out: OfGame[] = [];
  const lower = html.toLowerCase();
  let searchFrom = 0;

  while (true) {
    const rel = lower.indexOf("<article", searchFrom);
    if (rel < 0) break;
    const endRel = lower.indexOf("</article>", rel);
    if (endRel < 0) break;
    const end = endRel + "</article>".length;
    const block = html.slice(rel, end);
    searchFrom = end;
    const g = parseArticleBlock(block);
    if (g && !out.some((x) => x.id === g.id)) out.push(g);
  }

  return out;
}

export function detectMaxPage(html: string): number | null {
  const re = /\/games\/page\/(\d+)\//g;
  let max = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max > 0 ? max : null;
}

export async function scrapeAllListings(opts?: {
  delayMs?: number;
  maxPages?: number;
  onPage?: (page: number, max: number | null, count: number) => void;
}): Promise<OfGame[]> {
  const delayMs = opts?.delayMs ?? 400;
  const games: OfGame[] = [];
  const seen = new Set<string>();

  const firstUrl = `${SITE}/games/`;
  const firstHtml = await fetchText(firstUrl);
  let maxPage = detectMaxPage(firstHtml) ?? 1;
  if (opts?.maxPages) maxPage = Math.min(maxPage, opts.maxPages);

  const push = (list: OfGame[]) => {
    for (const g of list) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      games.push(g);
    }
  };

  push(parseListingHtml(firstHtml));
  opts?.onPage?.(1, maxPage, games.length);

  for (let page = 2; page <= maxPage; page++) {
    await sleep(delayMs);
    const url = `${SITE}/games/page/${page}/`;
    try {
      const html = await fetchText(url);
      const list = parseListingHtml(html);
      if (list.length === 0) {
        console.warn(`empty page ${page}, stopping`);
        break;
      }
      push(list);
      opts?.onPage?.(page, maxPage, games.length);
      // Refresh max if site grew
      const m = detectMaxPage(html);
      if (m && m > maxPage && !opts?.maxPages) maxPage = m;
    } catch (e) {
      console.warn(`page ${page} failed:`, e);
      // retry once
      await sleep(1500);
      try {
        const html = await fetchText(url);
        push(parseListingHtml(html));
        opts?.onPage?.(page, maxPage, games.length);
      } catch (e2) {
        console.error(`page ${page} retry failed:`, e2);
      }
    }
  }

  // Stable order: newest first as site lists (page1 first)
  void PAGE_SIZE_HINT;
  void collapseWs;
  return games;
}
