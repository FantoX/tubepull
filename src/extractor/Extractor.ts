import type { PlaylistInfo, VideoInfo } from '../types.js';

//---- Section used for the extractor contract ----

/** How media byte ranges are requested from the stream host. */
export type RangeMode = 'query' | 'header';

/** Request details the download engine needs for the formats of one extraction. */
export interface MediaRequest {
  /** Headers for media requests; streams must be fetched as the client that signed them. */
  headers: Record<string, string>;
  rangeMode: RangeMode;
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

/**
 * The only boundary that knows about YouTube. Swap or add engines by implementing this;
 * everything else in tubepull works on the normalised types.
 */
export interface Extractor {
  readonly name: string;
  /** Resolve a video ID to metadata plus formats with direct, deciphered URLs where possible. */
  getVideo(videoId: string, options?: GetVideoOptions): Promise<ExtractedVideo>;
  getPlaylist(playlistId: string, signal?: AbortSignal): Promise<PlaylistInfo>;
  /** Versions and settings for `tubepull doctor`. */
  describe(): Promise<Record<string, string>>;
}
