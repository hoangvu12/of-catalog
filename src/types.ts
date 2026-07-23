/** One Online-Fix listing row. */
export interface OfGame {
  id: string;
  title: string;
  /** Cleaned title used for Steam search. */
  titleClean: string;
  originPath: string;
  coverUrl?: string;
  version?: string;
  updatedAt?: string;
  steamAppId?: number;
}

/** Normalized Steam fields used by Ina browse and detail. */
export interface SteamAppData {
  appId: number;
  name?: string;
  description?: string;
  developer?: string;
  publisher?: string;
  releaseDate?: string;
  genres: string[];
  features: string[];
  metacritic?: { score: number; url: string };
  heroImage?: string;
  headerImage?: string;
  screenshots: Array<{ thumb: string; full: string }>;
  trailer?: {
    thumb: string;
    mp4?: string;
    hls?: string;
    name?: string;
  };
  platformSupport?: { windows: boolean; mac: boolean; linux: boolean };
  controllerSupport?: string;
  achievementsTotal?: number;
  recommendationsTotal?: number;
  languages: string[];
  requirements?: { minimum?: string; recommended?: string };
  contentDescriptors: string[];
  website?: string;
  /** ISO time this record was fetched. */
  fetchedAt: string;
}

export interface CatalogManifest {
  version: 1;
  mappingVersion: number;
  steamDataVersion: number;
  updatedAt: string;
  source: string;
  games: OfGame[];
  /** Normalized Steam app data keyed by appId string. */
  steam: Record<string, SteamAppData>;
  stats: {
    total: number;
    mapped: number;
    unmapped: number;
    steamRecords: number;
  };
}

export interface UnmappedEntry {
  id: string;
  title: string;
  titleClean: string;
  originPath: string;
  reason: string;
}

/** Manual overrides: OF id → steamAppId (or null to force unmapped). */
export type Overrides = Record<string, number | null>;
