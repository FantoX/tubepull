import type { PlaylistInfo, VideoInfo } from '../types.js';

export type RangeMode = 'query' | 'header';

export interface MediaRequest {
  /** Headers for media requests; streams must be fetched as the client that signed them. */
  headers: Record<string, string>;
  rangeMode: RangeMode;
  /** Epoch ms before which the stream host refuses these URLs (an enforced preroll ad is still "playing"). */
  playableAt?: number;
}

export interface ExtractedVideo {
  info: Omit<VideoInfo, 'qualities' | 'audioQualities'>;
  media: MediaRequest;
}

export interface GetVideoOptions {
  signal?: AbortSignal;
  /** Clients whose stream URLs were refused; extraction tries the others first. */
  excludeClients?: readonly string[];
}

/** Custom engines return the same normalized media types. */
export interface Extractor {
  readonly name: string;
  /** Return direct, deciphered format URLs where available. */
  getVideo(videoId: string, options?: GetVideoOptions): Promise<ExtractedVideo>;
  getPlaylist(playlistId: string, signal?: AbortSignal): Promise<PlaylistInfo>;
  /** Versions and settings for `tubepull doctor`. */
  describe(): Promise<Record<string, string>>;
}
