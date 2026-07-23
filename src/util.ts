import iconv from "iconv-lite";

export const SITE = "https://online-fix.me";
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 of-catalog/1.0";

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function collapseWs(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(" ");
}

export function stripTags(s: string): string {
  let out = "";
  let inTag = false;
  for (const c of s) {
    if (c === "<") inTag = true;
    else if (c === ">") inTag = false;
    else if (!inTag) out += c;
  }
  return out;
}

export function htmlUnescape(s: string): string {
  let t = s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ");
  t = t.replace(/&#(\d+);/g, (_, n) => {
    const cp = Number(n);
    return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;
  });
  return t;
}

export function cleanTitle(s: string): string {
  let t = collapseWs(s);
  for (let i = 0; i < 3; i++) {
    const before = t;
    for (const suffix of [
      " по сети",
      " ПО СЕТИ",
      " По сети",
      " online",
      " Online",
      " ONLINE",
      " — online-fix.me",
      " - online-fix.me",
      " | online-fix.me",
      " online-fix.me",
    ]) {
      if (t.endsWith(suffix)) t = t.slice(0, -suffix.length).trim();
    }
    while (t.endsWith("?") || t.endsWith("¿")) t = t.slice(0, -1).trimEnd();
    if (t === before) break;
  }
  return t;
}

export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function absolutize(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${SITE}${url}`;
  return `${SITE}/${url}`;
}

export function originPath(url: string): string {
  try {
    const u = new URL(absolutize(url));
    return u.pathname;
  } catch {
    return url.startsWith("/") ? url : `/${url}`;
  }
}

export function articleIdFromOrigin(url: string): string | null {
  const file = url.split("/").pop() ?? "";
  const m = file.match(/^(\d+)/);
  return m ? m[1]! : null;
}

export function decodeSiteHtml(buf: ArrayBuffer): string {
  const bytes = Buffer.from(buf);
  // OF serves windows-1251; Bun/Node TextDecoder often lacks that label.
  if (iconv.encodingExists("win1251")) {
    return iconv.decode(bytes, "win1251");
  }
  return bytes.toString("utf8");
}

export async function fetchBytes(
  url: string,
  init: RequestInit = {},
): Promise<ArrayBuffer> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9,ru;q=0.8",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.arrayBuffer();
}

export async function fetchText(url: string): Promise<string> {
  return decodeSiteHtml(await fetchBytes(url));
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json() as Promise<T>;
}

/** Simple concurrency pool. */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}
