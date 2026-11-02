import type { LyricData, OnlineLyricsState, SongResult } from '../../types';
import { saveToCache } from '../db';
import { saveLyricCacheSongMetadata } from '../lyricExport/lyricCacheMetadata';
import { omni } from '../onlineMusic/omni';
import { getSongCacheWithLegacyMigration } from '../onlineMusic/resourceCache';
import { getSongResourceCacheKey } from '../onlineMusic/resourceKeys';
import { useLyricSettingsStore } from '../../stores/useLyricSettingsStore';
import { autoMatchBestLyric } from '../../utils/lyrics/autoMatchBestLyric';
import { parseLyricsByFormat } from '../../utils/lyrics/parserCore';
import { isPureMusicLyricText } from '../../utils/lyrics/pureMusic';
import { migrateLyricDataRenderHints } from '../../utils/lyrics/renderHints';
import {
    loadOnlineLyricsState,
    markOnlineLyricsPureMusic,
    resolveOnlineLyrics,
    resolveOnlineLyricsPureMusic,
    saveOnlineLyricsState,
} from '../../utils/onlineLyricsState';

export interface LoadSmtcLyricsParams {
    song: SongResult;
    title: string;
    artist: string;
    album?: string;
    durationMs: number;
    isCurrent: () => boolean;
    onLyrics: (lyrics: LyricData | null) => void;
    onPureMusicChange?: (isPureMusic: boolean) => void;
    onStateChange?: (state: OnlineLyricsState | null) => void;
    onDone?: () => void;
}

const ENHANCED_LRC_ANGLE_REGEX = /<(\d{2,3}):(\d{2})[.:](\d{2,3})>/;

const stripTrackTitleNoise = (rawTitle: string): string =>
    rawTitle
        .replace(/\s*[-–—]\s*(?:\d{4}\s*)?(?:remaster(?:ed)?|live|mono|stereo|deluxe|version|edit|mix).*$/i, '')
        .replace(/\s*\((?:feat\.?|ft\.?|remaster(?:ed)?|deluxe|bonus track)[^)]*\)/gi, '')
        .trim();

const hasTranslationLines = (lyrics: LyricData | null | undefined): boolean =>
    Boolean(lyrics?.lines?.some(line => Boolean(line.translation?.trim())));

/**
 * Matches synced lyrics for Spotify Free / SMTC tracks:
 * 1. Respects user-imported / manually-matched OnlineLyricsState & IndexedDB lyric cache.
 * 2. Queries LRCLIB first (via Electron Main Process `smtc:fetch-lrclib`) and parses with Folia's `parseLyricsByFormat`.
 * 3. Falls back to (or upgrades word-by-word / translation via) Folia's built-in `autoMatchBestLyric` & NetEase public lyric API.
 */
export async function loadSmtcAndSpotifyLyrics({
    song,
    title,
    artist,
    album,
    durationMs,
    isCurrent,
    onLyrics,
    onPureMusicChange,
    onStateChange,
    onDone,
}: LoadSmtcLyricsParams): Promise<void> {
    let doneCalled = false;
    const finishOnce = () => {
        if (!doneCalled) {
            doneCalled = true;
            onDone?.();
        }
    };

    try {
        const cleanTitle = title.trim() || song.name.trim();
        const cleanArtist = artist.trim();
        if (!cleanTitle) {
            onLyrics(null);
            finishOnce();
            return;
        }

        const lyricCacheKey = getSongResourceCacheKey('lyric', song);
        const onlineLyricsState = await loadOnlineLyricsState(song);
        if (!isCurrent()) return;
        onStateChange?.(onlineLyricsState);

        const cachedLyrics = await getSongCacheWithLegacyMigration<LyricData>('lyric', song, migrateLyricDataRenderHints);
        if (!isCurrent()) return;

        const preferredCachedLyrics = resolveOnlineLyrics(onlineLyricsState, cachedLyrics);
        const hasAuthoritativeSelection = onlineLyricsState?.lyricsSource === 'imported'
            || Boolean(onlineLyricsState?.hasOnlineOverride);

        if (hasAuthoritativeSelection && onlineLyricsState?.matchedIsPureMusic === true && !preferredCachedLyrics) {
            onPureMusicChange?.(true);
            onLyrics(null);
            finishOnce();
            return;
        }

        const lyricSettings = useLyricSettingsStore.getState();
        if (
            preferredCachedLyrics
            && preferredCachedLyrics.lines.length > 0
            && (
                hasAuthoritativeSelection
                || !lyricSettings.autoUseBestLyric
                || preferredCachedLyrics.isWordByWord
                || hasTranslationLines(preferredCachedLyrics)
            )
        ) {
            const cachedText = preferredCachedLyrics.lines.map(line => line.fullText).join('\n');
            onPureMusicChange?.(resolveOnlineLyricsPureMusic(onlineLyricsState, cachedText));
            onLyrics(preferredCachedLyrics);
            finishOnce();
            return;
        }

        // Step 1: Query LRCLIB first
        let lrclibLyrics: LyricData | null = null;
        let lrclibInstrumental = false;

        if (window.electron?.smtc?.fetchLrclib) {
            const durationSec = durationMs > 0 ? durationMs / 1000 : undefined;
            const firstResponse = await window.electron.smtc.fetchLrclib({
                title: cleanTitle,
                artist: cleanArtist,
                album,
                durationSec,
            });
            let lrclibResult = firstResponse?.data ?? null;

            if (!lrclibResult?.syncedLyrics && !lrclibResult?.instrumental) {
                const strippedTitle = stripTrackTitleNoise(cleanTitle);
                if (strippedTitle && strippedTitle !== cleanTitle) {
                    const retryResponse = await window.electron.smtc.fetchLrclib({
                        title: strippedTitle,
                        artist: cleanArtist,
                        album,
                        durationSec,
                    });
                    lrclibResult = retryResponse?.data ?? null;
                }
            }

            if (!isCurrent()) return;

            if (lrclibResult?.syncedLyrics) {
                const format = ENHANCED_LRC_ANGLE_REGEX.test(lrclibResult.syncedLyrics) ? 'enhanced-lrc' : 'lrc';
                const parsed = parseLyricsByFormat(format, lrclibResult.syncedLyrics);
                if (parsed.lines.length > 0) {
                    lrclibLyrics = parsed;
                    const parsedText = parsed.lines.map(line => line.fullText).join('\n');
                    onPureMusicChange?.(isPureMusicLyricText(parsedText));
                    onLyrics(parsed);
                    void saveToCache(lyricCacheKey, parsed);
                    saveLyricCacheSongMetadata(song);
                    finishOnce();
                }
            } else if (lrclibResult?.instrumental === true) {
                lrclibInstrumental = true;
            }
        }

        // If cached lyrics existed (even without word-by-word) and LRCLIB missed, show cached immediately while checking NetEase
        if (!lrclibLyrics && preferredCachedLyrics && preferredCachedLyrics.lines.length > 0) {
            lrclibLyrics = preferredCachedLyrics;
            onPureMusicChange?.(false);
            onLyrics(preferredCachedLyrics);
            finishOnce();
        }

        // Step 2: Query NetEase / Folia's built-in autoMatchBestLyric pipeline
        // Runs when LRCLIB had no synced lyrics OR when autoUseBestLyric wants word-by-word/translation upgrade
        const wantsUpgrade = Boolean(
            lrclibLyrics
            && lyricSettings.autoUseBestLyric
            && !hasAuthoritativeSelection
            && (!lrclibLyrics.isWordByWord || !hasTranslationLines(lrclibLyrics)),
        );

        if (!lrclibLyrics || wantsUpgrade) {
            try {
                const bestMatch = await autoMatchBestLyric(
                    cleanTitle,
                    cleanArtist,
                    durationMs > 0 ? durationMs : 0,
                    {
                        album,
                        preferredSource: lyricSettings.preferredAlternativeLyricSource,
                    },
                );
                if (!isCurrent()) return;

                if (bestMatch && 'lyrics' in bestMatch && bestMatch.lyrics.lines.length > 0) {
                    const isBetterThanLrclib = !lrclibLyrics
                        || Boolean(bestMatch.lyrics.isWordByWord && !lrclibLyrics.isWordByWord)
                        || (hasTranslationLines(bestMatch.lyrics) && !hasTranslationLines(lrclibLyrics));

                    if (isBetterThanLrclib) {
                        const overrideState: OnlineLyricsState = {
                            lyricsSource: 'online',
                            matchedSongId: bestMatch.id,
                            hasOnlineOverride: true,
                            onlineOverrideLyrics: bestMatch.lyrics,
                            matchedLyricsSource: bestMatch.source,
                            matchedLyricsProviderPlatform: bestMatch.matchedLyricsProviderPlatform,
                        };
                        await saveOnlineLyricsState(song, overrideState);
                        if (!isCurrent()) return;
                        onStateChange?.(overrideState);
                        onPureMusicChange?.(false);
                        onLyrics(bestMatch.lyrics);
                        void saveToCache(lyricCacheKey, bestMatch.lyrics);
                        saveLyricCacheSongMetadata(song);
                        finishOnce();
                        return;
                    }
                } else if (!lrclibLyrics && bestMatch?.isPureMusic === true) {
                    const pureState = markOnlineLyricsPureMusic(onlineLyricsState);
                    await saveOnlineLyricsState(song, pureState);
                    if (!isCurrent()) return;
                    onStateChange?.(pureState);
                    onPureMusicChange?.(true);
                    onLyrics(null);
                    finishOnce();
                    return;
                }
            } catch (error) {
                console.warn('[SMTC Lyrics] autoMatchBestLyric failed, trying direct NetEase fallback:', error);
            }
        }

        // Direct NetEase public lyric API fallback if both LRCLIB and autoMatchBestLyric returned no synced lyrics
        if (!lrclibLyrics && !lrclibInstrumental) {
            try {
                const query = `${stripTrackTitleNoise(cleanTitle) || cleanTitle} ${cleanArtist}`.trim();
                const searchPage = await omni.searchProviderSongs('netease', query, { limit: 3, offset: 0 });
                if (!isCurrent()) return;

                const candidates = searchPage?.items ?? [];
                for (const candidate of candidates) {
                    if (durationMs > 0 && candidate.durationMs > 0 && Math.abs(candidate.durationMs - durationMs) > 12000) {
                        continue;
                    }
                    const neteaseLyrics = await omni.getLyrics(candidate);
                    if (!isCurrent()) return;
                    if (neteaseLyrics?.lyrics && neteaseLyrics.lyrics.lines.length > 0) {
                        const overrideState: OnlineLyricsState = {
                            lyricsSource: 'online',
                            matchedSongId: candidate.id,
                            hasOnlineOverride: true,
                            onlineOverrideLyrics: neteaseLyrics.lyrics,
                            matchedLyricsSource: 'netease',
                        };
                        await saveOnlineLyricsState(song, overrideState);
                        if (!isCurrent()) return;
                        onStateChange?.(overrideState);
                        onPureMusicChange?.(false);
                        onLyrics(neteaseLyrics.lyrics);
                        void saveToCache(lyricCacheKey, neteaseLyrics.lyrics);
                        saveLyricCacheSongMetadata(song);
                        finishOnce();
                        return;
                    }
                    if (neteaseLyrics?.isPureMusic) {
                        lrclibInstrumental = true;
                        break;
                    }
                }
            } catch (error) {
                console.warn('[SMTC Lyrics] Direct NetEase fallback failed:', error);
            }
        }

        if (!isCurrent()) return;

        if (!lrclibLyrics) {
            if (lrclibInstrumental) {
                onPureMusicChange?.(true);
            }
            onLyrics(null);
        }
    } finally {
        if (isCurrent()) {
            finishOnce();
        }
    }
}
