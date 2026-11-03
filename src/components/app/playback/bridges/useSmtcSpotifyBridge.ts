import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { PlayerState, type LyricData, type SongResult } from '../../../../types';
import type { NextTrackOptions } from '../../../../types/appPlayback';
import type { ThemeCacheSongKey } from '../../../../services/themeCache';
import { hifiTransport, isHifiRoute } from '../../../../services/hifi/hifiPlayback';
import { getCachedSongCoverUrl } from '../../../../services/onlineMusic/resourceCache';
import { getSongAlbumLabel, getSongArtistLabel, getSongCoverUrl } from '../../../../services/onlineMusic/songMetadata';
import { loadSmtcAndSpotifyLyrics } from '../../../../services/smtc/smtcLyricsMatcher';
import { currentTime } from '../../../../stores/motionSignals';
import {
    activateFoliaSpotifyTrack,
    buildSmtcTrackKey,
    clearPendingRequestedSmtcTrack,
    doesSmtcTitleArtistMatch,
    getLastManualSmtcPauseMs,
    getPendingRequestedSmtcTrack,
    isInSmtcSeekGuard,
    isSmtcRouteActive,
    isSmtcSpotifySupported,
    type SmtcPlaybackStatus,
    syncSmtcClockAnchor,
    useSmtcSpotifyStore,
} from '../../../../services/smtc/smtcSpotifyStore';
import { useAudioSettingsStore } from '../../../../stores/useAudioSettingsStore';
import {
    setAudioSrc,
    setCachedCoverUrl,
    setCurrentLineIndex,
    setCurrentSong,
    setDuration,
    setPlayQueue,
    setPlayerState,
    usePlaybackStore,
} from '../../../../stores/usePlaybackStore';
import { getOnlineProviderIdForSong, getPlaybackSongKey, isSamePlaybackSong } from '../../../../utils/appPlaybackGuards';
import { toSafeRemoteUrl } from '../../../../utils/appPlaybackHelpers';
import { supplyLyricsAfterEmptyLoad } from '../createLyricsSetter';
import { askedSongKeyRef, askForSong, showSong } from '../currentSong';

type SetState<T> = Dispatch<SetStateAction<T>>;

export interface UseSmtcSpotifyBridgeParams {
    audioRef: MutableRefObject<HTMLAudioElement | null>;
    setLyrics: (nextLyrics: LyricData | null) => void;
    setIsLyricsLoading: SetState<boolean>;
    restoreCachedThemeForSong: (
        songOrId: ThemeCacheSongKey | SongResult,
        options?: { allowLastUsedFallback?: boolean; preserveCurrentOnMiss?: boolean },
    ) => Promise<unknown>;
    handleNextTrack: (options?: NextTrackOptions) => Promise<void> | void;
    isNowPlayingStageActive: boolean;
    isPlayerCapStageActive: boolean;
}

const AD_SONG_ID = 'smtc:__spotify_advertisement__';

const isSpotifyAdvertisement = (status: SmtcPlaybackStatus): boolean => {
    const title = status.title.trim();
    const artist = status.artist.trim();
    if (!title) return false;
    if (/^advertisement$/i.test(title)) return true;
    if (/^spotify$/i.test(artist) && /^(advertisement|spotify|music for everyone)$/i.test(title)) return true;
    return false;
};

export function useSmtcSpotifyBridge({
    audioRef,
    setLyrics,
    setIsLyricsLoading,
    restoreCachedThemeForSong,
    handleNextTrack,
    isNowPlayingStageActive,
    isPlayerCapStageActive,
}: UseSmtcSpotifyBridgeParams): void {
    const latestHandlersRef = useRef({
        setLyrics,
        setIsLyricsLoading,
        restoreCachedThemeForSong,
        handleNextTrack,
        isNowPlayingStageActive,
        isPlayerCapStageActive,
    });
    latestHandlersRef.current = {
        setLyrics,
        setIsLyricsLoading,
        restoreCachedThemeForSong,
        handleNextTrack,
        isNowPlayingStageActive,
        isPlayerCapStageActive,
    };

    const prevStatusRef = useRef<{
        trackKey: string;
        isPlaying: boolean;
        positionMs: number;
        durationMs: number;
    }>({
        trackKey: '',
        isPlaying: false,
        positionMs: 0,
        durationMs: 0,
    });
    const lastFetchedLyricKeyRef = useRef<string>('');
    const autoAdvanceLockTrackKeyRef = useRef<string>('');

    useEffect(() => {
        if (!isSmtcSpotifySupported() || !window.electron?.smtc) {
            return undefined;
        }

        const silenceInternalEngines = () => {
            if (audioRef.current && !audioRef.current.paused) {
                audioRef.current.pause();
            }
            if (isHifiRoute()) {
                void hifiTransport.pause();
            }
        };

        const handleStatus = (status: SmtcPlaybackStatus) => {
            const {
                setLyrics: applyLyrics,
                setIsLyricsLoading: applyLyricsLoading,
                restoreCachedThemeForSong: applyTheme,
                handleNextTrack: advanceNextTrack,
                isNowPlayingStageActive: stageNowPlaying,
                isPlayerCapStageActive: stagePlayerCap,
            } = latestHandlersRef.current;

            if (useSmtcSpotifyStore.getState().hasSession !== status.hasSession) {
                useSmtcSpotifyStore.setState({ hasSession: status.hasSession });
            }

            if (stageNowPlaying || stagePlayerCap) {
                return;
            }

            const prev = prevStatusRef.current;
            const liveStore = usePlaybackStore.getState();
            if (liveStore.activePlaybackContext === 'stage') {
                return;
            }

            if (!status.hasSession || !status.title.trim()) {
                if (getPendingRequestedSmtcTrack()) {
                    return;
                }
                if (isSmtcRouteActive() && prev.isPlaying) {
                    syncSmtcClockAnchor(0, liveStore.duration, false, { forceSnap: true });
                    setPlayerState(PlayerState.PAUSED);
                }
                prevStatusRef.current = {
                    trackKey: '',
                    isPlaying: false,
                    positionMs: 0,
                    durationMs: 0,
                };
                return;
            }

            const incomingTrackKey = buildSmtcTrackKey(status.title, status.artist);
            const currentSong = liveStore.currentSong;
            const currentProvider = getOnlineProviderIdForSong(currentSong);
            const isCurrentSpotifyOrSmtc = Boolean(
                currentSong && (currentProvider === 'spotify' || String(currentSong.id).startsWith('smtc:')),
            );

            // Decide whether SMTC should activate when not yet active
            if (!isSmtcRouteActive()) {
                const externalJustStartedPlaying = status.isPlaying && !prev.isPlaying;
                const foliaIsBusyWithOtherAudio = Boolean(
                    currentSong
                    && !isCurrentSpotifyOrSmtc
                    && (liveStore.playerState === PlayerState.PLAYING || liveStore.isLoadingToPlay),
                );

                if (foliaIsBusyWithOtherAudio && !externalJustStartedPlaying) {
                    prevStatusRef.current = {
                        trackKey: incomingTrackKey,
                        isPlaying: status.isPlaying,
                        positionMs: status.position,
                        durationMs: status.duration,
                    };
                    return;
                }

                // Only auto-attach if Spotify is playing or Folia already displays a Spotify track
                if (!status.isPlaying && !isCurrentSpotifyOrSmtc) {
                    prevStatusRef.current = {
                        trackKey: incomingTrackKey,
                        isPlaying: status.isPlaying,
                        positionMs: status.position,
                        durationMs: status.duration,
                    };
                    return;
                }

                silenceInternalEngines();
                useSmtcSpotifyStore.setState({
                    active: true,
                    isExternalTrack: !isCurrentSpotifyOrSmtc,
                });
            }

            // 1. Handle Spotify Free Advertisement breaks gracefully
            if (isSpotifyAdvertisement(status)) {
                clearPendingRequestedSmtcTrack();
                silenceInternalEngines();
                const adDurationSec = status.duration > 0 ? status.duration / 1000 : 30;
                const adPositionSec = Math.max(0, status.position / 1000);

                if (liveStore.currentSong?.id !== AD_SONG_ID) {
                    const adSong: SongResult = {
                        id: AD_SONG_ID,
                        name: '廣告插播中 (Spotify)',
                        artists: [{ id: 0, name: 'Spotify' }],
                        album: { id: 0, name: 'Spotify Advertisement', coverUrl: '' },
                        durationMs: Math.round(adDurationSec * 1000),
                        isPureMusic: true,
                        sourceRef: {
                            kind: 'online',
                            providerId: 'spotify',
                            mediaId: AD_SONG_ID,
                        },
                    };
                    askForSong(adSong);
                    showSong(adSong);
                    setAudioSrc(null);
                    applyLyrics(null);
                    applyLyricsLoading(false);
                    setCurrentLineIndex(-1);
                    lastFetchedLyricKeyRef.current = AD_SONG_ID;
                }

                if (status.thumbnail && liveStore.cachedCoverUrl !== status.thumbnail) {
                    setCachedCoverUrl(status.thumbnail);
                }
                if (adDurationSec > 0 && Math.abs(liveStore.duration - adDurationSec) > 0.25) {
                    setDuration(adDurationSec);
                }
                syncSmtcClockAnchor(adPositionSec, adDurationSec, status.isPlaying);
                const targetAdState = status.isPlaying ? PlayerState.PLAYING : PlayerState.PAUSED;
                if (liveStore.playerState !== targetAdState) {
                    setPlayerState(targetAdState);
                }
                if (!useSmtcSpotifyStore.getState().isAdvertisement) {
                    useSmtcSpotifyStore.setState({ isAdvertisement: true, trackKey: incomingTrackKey });
                }

                prevStatusRef.current = {
                    trackKey: incomingTrackKey,
                    isPlaying: status.isPlaying,
                    positionMs: status.position,
                    durationMs: status.duration,
                };
                return;
            }

            // 2. Guard against stale SMTC ticks right after clicking a new song in Folia
            const pending = getPendingRequestedSmtcTrack();
            if (pending) {
                if (doesSmtcTitleArtistMatch(status.title, status.artist, pending.title, pending.artist)) {
                    if (status.isPlaying) {
                        clearPendingRequestedSmtcTrack();
                        const startSec = Math.max(0, status.position / 1000);
                        const durSec = status.duration > 0 ? status.duration / 1000 : liveStore.duration;
                        syncSmtcClockAnchor(startSec, durSec, true, { forceSnap: true });
                        currentTime.set(startSec);
                    }
                } else {
                    // Still receiving the old track's last tick while Spotify switches URIs; ignore it
                    return;
                }
            }

            if (useSmtcSpotifyStore.getState().isAdvertisement) {
                useSmtcSpotifyStore.setState({ isAdvertisement: false });
            }

            // 3. Detect track change (either external Spotify track switch or post-ad transition)
            const latestSong = usePlaybackStore.getState().currentSong;
            const matchesDisplayedSong = Boolean(
                latestSong
                && latestSong.id !== AD_SONG_ID
                && doesSmtcTitleArtistMatch(
                    status.title,
                    status.artist,
                    latestSong.name,
                    getSongArtistLabel(latestSong),
                ),
            );

            if (!matchesDisplayedSong) {
                silenceInternalEngines();
                autoAdvanceLockTrackKeyRef.current = '';

                const queue = usePlaybackStore.getState().playQueue;
                const matchedQueueSong = queue.find(candidate =>
                    doesSmtcTitleArtistMatch(
                        status.title,
                        status.artist,
                        candidate.name,
                        getSongArtistLabel(candidate),
                    ),
                );

                const resolvedDurationMs = status.duration > 0
                    ? status.duration
                    : (matchedQueueSong?.durationMs ?? 0);

                const nextSong: SongResult = matchedQueueSong
                    ? (resolvedDurationMs > 0 && !matchedQueueSong.durationMs
                        ? { ...matchedQueueSong, durationMs: resolvedDurationMs }
                        : matchedQueueSong)
                    : {
                        id: `smtc:${incomingTrackKey}`,
                        name: status.title.trim(),
                        artists: [{ id: 0, name: status.artist.trim() || 'Spotify' }],
                        album: {
                            id: 0,
                            name: status.album.trim(),
                            coverUrl: '',
                        },
                        durationMs: resolvedDurationMs,
                        sourceRef: {
                            kind: 'online',
                            providerId: 'spotify',
                            mediaId: `smtc:${incomingTrackKey}`,
                        },
                    };

                const isExternal = !matchedQueueSong;
                useSmtcSpotifyStore.setState({
                    active: true,
                    isExternalTrack: isExternal,
                    isAdvertisement: false,
                    trackKey: incomingTrackKey,
                });

                askForSong(nextSong);
                const songKey = getPlaybackSongKey(nextSong);
                showSong(nextSong);
                setAudioSrc(null);
                applyLyrics(null);
                setCurrentLineIndex(-1);

                if (isExternal && queue.length <= 1) {
                    setPlayQueue([nextSong]);
                }

                const remoteCover = toSafeRemoteUrl(getSongCoverUrl(nextSong));
                if (remoteCover) {
                    setCachedCoverUrl(remoteCover);
                    void getCachedSongCoverUrl(nextSong).then(cached => {
                        if (cached && askedSongKeyRef.current === songKey) {
                            setCachedCoverUrl(cached);
                        }
                    });
                } else {
                    setCachedCoverUrl(status.thumbnail || null);
                }

                const durationSec = resolvedDurationMs > 0 ? resolvedDurationMs / 1000 : 0;
                setDuration(durationSec);
                syncSmtcClockAnchor(Math.max(0, status.position / 1000), durationSec, status.isPlaying, { forceSnap: true });
                const shouldKeepPlaying = status.isPlaying || Boolean(getPendingRequestedSmtcTrack()) || liveStore.isLoadingToPlay;
                setPlayerState(shouldKeepPlaying ? PlayerState.PLAYING : PlayerState.PAUSED);

                lastFetchedLyricKeyRef.current = songKey;
                applyLyricsLoading(true);
                void loadSmtcAndSpotifyLyrics({
                    song: nextSong,
                    title: status.title.trim() || nextSong.name,
                    artist: status.artist.trim() || getSongArtistLabel(nextSong),
                    album: status.album.trim() || getSongAlbumLabel(nextSong),
                    durationMs: resolvedDurationMs,
                    isCurrent: () => askedSongKeyRef.current === songKey,
                    onLyrics: resolvedLyrics => applyLyrics(resolvedLyrics),
                    onPureMusicChange: isPureMusic => {
                        setCurrentSong(prevSong => {
                            if (!prevSong || !isSamePlaybackSong(prevSong, nextSong)) return prevSong;
                            return { ...prevSong, isPureMusic };
                        });
                    },
                    onStateChange: state => {
                        setCurrentSong(prevSong => {
                            if (!prevSong || !isSamePlaybackSong(prevSong, nextSong)) return prevSong;
                            return { ...prevSong, onlineLyricsState: state ?? undefined };
                        });
                    },
                    onDone: () => applyLyricsLoading(false),
                }).then(() => {
                    if (askedSongKeyRef.current === songKey) {
                        supplyLyricsAfterEmptyLoad();
                    }
                });

                void applyTheme(nextSong).catch(() => {});

                prevStatusRef.current = {
                    trackKey: incomingTrackKey,
                    isPlaying: status.isPlaying,
                    positionMs: status.position,
                    durationMs: status.duration,
                };
                return;
            }

            // 4. Same track: update cover thumbnail if missing, sync duration, position & transport state
            const activeStore = usePlaybackStore.getState();
            const activeSmtc = useSmtcSpotifyStore.getState();
            if (activeSmtc.trackKey !== incomingTrackKey) {
                useSmtcSpotifyStore.setState({ trackKey: incomingTrackKey });
            }

            if (
                status.thumbnail
                && !activeStore.cachedCoverUrl
                && !toSafeRemoteUrl(getSongCoverUrl(activeStore.currentSong))
            ) {
                setCachedCoverUrl(status.thumbnail);
            }

            const durationSec = status.duration > 0
                ? status.duration / 1000
                : activeStore.duration;
            if (durationSec > 0 && Math.abs(activeStore.duration - durationSec) > 0.25) {
                setDuration(durationSec);
            }

            const isWaitingForPendingPlay = Boolean(getPendingRequestedSmtcTrack() && !status.isPlaying);
            const inSeekGuard = isInSmtcSeekGuard();

            // Check if a Folia-launched single Spotify URI finished naturally so Folia's queue can auto-advance
            const effectiveDurationMs = status.duration > 0 ? status.duration : prev.durationMs;
            const recentlyPausedManually = Date.now() - getLastManualSmtcPauseMs() < 2500;
            const finishedSingleUriNaturally = Boolean(
                !activeSmtc.isExternalTrack
                && !isWaitingForPendingPlay
                && !inSeekGuard
                && prev.trackKey === incomingTrackKey
                && prev.isPlaying
                && !status.isPlaying
                && !recentlyPausedManually
                && effectiveDurationMs > 5000
                && (
                    prev.positionMs >= effectiveDurationMs - 4500
                    || status.position >= effectiveDurationMs - 3000
                    || (status.position <= 1000 && prev.positionMs >= effectiveDurationMs * 0.85)
                ),
            );

            if (finishedSingleUriNaturally && autoAdvanceLockTrackKeyRef.current !== incomingTrackKey) {
                autoAdvanceLockTrackKeyRef.current = incomingTrackKey;
                const loopMode = useAudioSettingsStore.getState().loopMode;
                if (loopMode === 'one' && activeStore.currentSong) {
                    void activateFoliaSpotifyTrack(activeStore.currentSong);
                    return;
                }
                if (activeStore.playQueue.length > 1 || activeStore.isFmMode) {
                    void advanceNextTrack({ allowStopOnMissing: true, shouldNavigateToPlayer: false });
                    return;
                }
            }

            if (status.isPlaying && autoAdvanceLockTrackKeyRef.current === incomingTrackKey && status.position < 5000) {
                autoAdvanceLockTrackKeyRef.current = '';
            }

            const positionSec = Math.max(0, status.position / 1000);
            if (!isWaitingForPendingPlay) {
                syncSmtcClockAnchor(positionSec, durationSec, status.isPlaying);
            }

            const nextPlayerState = (status.isPlaying || isWaitingForPendingPlay || (inSeekGuard && activeStore.playerState === PlayerState.PLAYING))
                ? PlayerState.PLAYING
                : PlayerState.PAUSED;
            if (activeStore.playerState !== nextPlayerState && !activeStore.isLoadingToPlay && !isWaitingForPendingPlay) {
                setPlayerState(nextPlayerState);
            } else if (activeStore.isLoadingToPlay && status.isPlaying) {
                setPlayerState(PlayerState.PLAYING);
            }

            // Ensure lyrics were fetched if a song was passively restored without lyrics
            if (activeStore.currentSong) {
                const songKey = getPlaybackSongKey(activeStore.currentSong);
                if (
                    !activeStore.lyrics
                    && !activeStore.currentSong.isPureMusic
                    && lastFetchedLyricKeyRef.current !== songKey
                ) {
                    const targetSong = activeStore.currentSong;
                    lastFetchedLyricKeyRef.current = songKey;
                    applyLyricsLoading(true);
                    void loadSmtcAndSpotifyLyrics({
                        song: targetSong,
                        title: status.title.trim() || targetSong.name,
                        artist: status.artist.trim() || getSongArtistLabel(targetSong),
                        album: status.album.trim() || getSongAlbumLabel(targetSong),
                        durationMs: effectiveDurationMs || targetSong.durationMs || 0,
                        isCurrent: () => askedSongKeyRef.current === songKey,
                        onLyrics: resolvedLyrics => applyLyrics(resolvedLyrics),
                        onPureMusicChange: isPureMusic => {
                            setCurrentSong(prevSong => {
                                if (!prevSong || !isSamePlaybackSong(prevSong, targetSong)) return prevSong;
                                return { ...prevSong, isPureMusic };
                            });
                        },
                        onStateChange: state => {
                            setCurrentSong(prevSong => {
                                if (!prevSong || !isSamePlaybackSong(prevSong, targetSong)) return prevSong;
                                return { ...prevSong, onlineLyricsState: state ?? undefined };
                            });
                        },
                        onDone: () => applyLyricsLoading(false),
                    }).then(() => {
                        if (askedSongKeyRef.current === songKey) {
                            supplyLyricsAfterEmptyLoad();
                        }
                    });
                }
            }

            prevStatusRef.current = {
                trackKey: incomingTrackKey,
                isPlaying: status.isPlaying,
                positionMs: status.position,
                durationMs: status.duration,
            };
        };

        const unsubscribe = window.electron.smtc.onStatusUpdate(handleStatus);
        void window.electron.smtc.getStatus().then(initial => {
            if (initial) handleStatus(initial);
        }).catch(() => {});

        return () => {
            unsubscribe();
        };
    }, [audioRef]);
}
