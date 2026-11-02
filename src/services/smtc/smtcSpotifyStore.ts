import { create } from 'zustand';
import { PlayerState, type SongResult } from '../../types';
import { currentTime } from '../../stores/motionSignals';
import { setPlayerState, usePlaybackStore } from '../../stores/usePlaybackStore';
import { getSongArtistLabel } from '../onlineMusic/songMetadata';
import { convertChineseTextToTraditional } from '../../utils/lyrics/chineseConverter';

export interface SmtcPlaybackStatus {
    hasSession: boolean;
    appId: string;
    title: string;
    artist: string;
    album: string;
    duration: number;
    position: number;
    isPlaying: boolean;
    playbackStatus: string;
    thumbnail: string | null;
    timestamp: number;
}

export interface SmtcSpotifyState {
    active: boolean;
    isExternalTrack: boolean;
    isAdvertisement: boolean;
    hasSession: boolean;
    trackKey: string;
    isPendingSwitch: boolean;
}

export const useSmtcSpotifyStore = create<SmtcSpotifyState>(() => ({
    active: false,
    isExternalTrack: false,
    isAdvertisement: false,
    hasSession: false,
    trackKey: '',
    isPendingSwitch: false,
}));

let anchorPositionSec = 0;
let anchorPerfMs = 0;
let anchorDurationSec = 0;
let anchorIsPlaying = false;
let seekGuardUntilPerfMs = 0;
let lastManualPauseAtMs = 0;

interface PendingRequestedTrack {
    title: string;
    artist: string;
    trackId: string | null;
    expiresAtMs: number;
}

let pendingRequestedTrack: PendingRequestedTrack | null = null;

const nowPerf = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export const normalizeSmtcToken = (value: string | null | undefined): string =>
    convertChineseTextToTraditional(String(value ?? ''))
        .trim()
        .toLowerCase()
        .replace(/\s*\((?:feat\.?|ft\.?|with|remaster(?:ed)?|live|deluxe|version)[^)]*\)/gi, '')
        .replace(/\s*-\s*(?:remaster(?:ed)?|single|mono|stereo|live).*$/gi, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();

const extractPrimaryArtist = (artistNorm: string): string => {
    if (!artistNorm) return '';
    return artistNorm.split(/[,/&、;]| feat\.? | ft\.? /i)[0]?.trim() ?? artistNorm;
};

export const buildSmtcTrackKey = (title: string | null | undefined, artist: string | null | undefined): string =>
    `${normalizeSmtcToken(title)}|${normalizeSmtcToken(artist)}`;

export const doesSmtcTitleArtistMatch = (
    titleA: string | null | undefined,
    artistA: string | null | undefined,
    titleB: string | null | undefined,
    artistB: string | null | undefined,
): boolean => {
    const tA = normalizeSmtcToken(titleA);
    const tB = normalizeSmtcToken(titleB);
    if (!tA || !tB) return false;
    if (tA !== tB && !tA.includes(tB) && !tB.includes(tA)) return false;

    const aA = normalizeSmtcToken(artistA);
    const aB = normalizeSmtcToken(artistB);
    if (!aA || !aB) return true;
    if (aA === aB || aA.includes(aB) || aB.includes(aA)) return true;

    const pA = extractPrimaryArtist(aA);
    const pB = extractPrimaryArtist(aB);
    return Boolean(pA && pB && (pA === pB || pA.includes(pB) || pB.includes(pA)));
};

export const extractSpotifyTrackId = (song: SongResult | null | undefined): string | null => {
    if (!song) return null;
    const rawCandidate = song.sourceRef?.kind === 'online' && song.sourceRef.providerId === 'spotify'
        ? String(song.sourceRef.mediaId ?? '')
        : String(song.id ?? '');
    const stripped = rawCandidate
        .trim()
        .replace(/^spotify:track:/i, '')
        .replace(/^spotify:/i, '')
        .replace(/^https?:\/\/open\.spotify\.com\/track\//i, '')
        .split(/[?#]/)[0]
        ?.trim() ?? '';
    return /^[A-Za-z0-9]{22}$/.test(stripped) ? stripped : null;
};

export const isSmtcSpotifySupported = (): boolean =>
    typeof window !== 'undefined' && Boolean(window.electron?.smtc?.isSupported);

let cachedIsPremium: boolean | null = null;
let lastPremiumCheckAt = 0;

export const isSpotifyPremiumAccount = async (): Promise<boolean> => {
    if (cachedIsPremium !== null && Date.now() - lastPremiumCheckAt < 15000) {
        return cachedIsPremium;
    }
    try {
        if (typeof window !== 'undefined' && typeof window.electron?.spotifyRequest === 'function') {
            const res = await window.electron.spotifyRequest('login_status', {});
            if (res && res.ok && res.data) {
                const user = res.data as { vipType?: number };
                cachedIsPremium = Boolean(user.vipType && user.vipType > 0);
                lastPremiumCheckAt = Date.now();
                return cachedIsPremium;
            }
        }
    } catch {
        // Fallback to Free / SMTC route
    }
    cachedIsPremium = false;
    lastPremiumCheckAt = Date.now();
    return false;
};

export const isSpotifyPremiumSynchronous = (): boolean => Boolean(cachedIsPremium);

export const clearSpotifyPremiumCache = (): void => {
    cachedIsPremium = null;
    lastPremiumCheckAt = 0;
};

export const isSmtcRouteActive = (): boolean =>
    useSmtcSpotifyStore.getState().active;

export const getSmtcPositionSec = (): number => {
    if (!anchorIsPlaying) {
        return Math.max(0, anchorPositionSec);
    }
    const elapsedSec = Math.max(0, (nowPerf() - anchorPerfMs) / 1000);
    const extrapolated = anchorPositionSec + elapsedSec;
    if (anchorDurationSec > 0) {
        return Math.max(0, Math.min(extrapolated, anchorDurationSec));
    }
    return Math.max(0, extrapolated);
};

export const syncSmtcClockAnchor = (
    positionSec: number,
    durationSec: number,
    isPlaying: boolean,
    options?: { forceSnap?: boolean },
): void => {
    const perf = nowPerf();
    if (Number.isFinite(durationSec) && durationSec > 0) {
        anchorDurationSec = durationSec;
    }

    if (!options?.forceSnap && perf < seekGuardUntilPerfMs) {
        if (isPlaying) {
            anchorIsPlaying = true;
        }
        return;
    }

    const safePos = Number.isFinite(positionSec) && positionSec >= 0 ? positionSec : 0;
    const currentPos = getSmtcPositionSec();
    const delta = safePos - currentPos;

    // Prevent small backward jitter (< 480ms) from Windows SMTC timeline quantization while playing smoothly
    if (!options?.forceSnap && isPlaying && anchorIsPlaying && delta < 0 && delta > -0.48) {
        anchorPositionSec = currentPos;
    } else {
        anchorPositionSec = anchorDurationSec > 0 ? Math.min(safePos, anchorDurationSec) : safePos;
    }

    anchorPerfMs = perf;
    anchorIsPlaying = isPlaying;
};

export const getPendingRequestedSmtcTrack = (): PendingRequestedTrack | null => {
    if (!pendingRequestedTrack) {
        if (useSmtcSpotifyStore.getState().isPendingSwitch) {
            useSmtcSpotifyStore.setState({ isPendingSwitch: false });
        }
        return null;
    }
    if (Date.now() > pendingRequestedTrack.expiresAtMs) {
        pendingRequestedTrack = null;
        if (useSmtcSpotifyStore.getState().isPendingSwitch) {
            useSmtcSpotifyStore.setState({ isPendingSwitch: false });
        }
        return null;
    }
    return pendingRequestedTrack;
};

export const clearPendingRequestedSmtcTrack = (): void => {
    pendingRequestedTrack = null;
    if (useSmtcSpotifyStore.getState().isPendingSwitch) {
        useSmtcSpotifyStore.setState({ isPendingSwitch: false });
    }
};

export const getLastManualSmtcPauseMs = (): number => lastManualPauseAtMs;

export const isInSmtcSeekGuard = (): boolean => nowPerf() < seekGuardUntilPerfMs;

export const activateFoliaSpotifyTrack = async (song: SongResult): Promise<boolean> => {
    if (!isSmtcSpotifySupported()) return false;
    const trackId = extractSpotifyTrackId(song);
    const title = song.name || '';
    const artist = getSongArtistLabel(song) || '';
    const durationSec = Math.max(0, (song.durationMs || 0) / 1000);
    const trackKey = buildSmtcTrackKey(title, artist);

    pendingRequestedTrack = {
        title,
        artist,
        trackId,
        expiresAtMs: Date.now() + 6500,
    };
    seekGuardUntilPerfMs = 0;
    syncSmtcClockAnchor(0, durationSec, true, { forceSnap: true });
    currentTime.set(0);

    useSmtcSpotifyStore.setState({
        active: true,
        isExternalTrack: false,
        isAdvertisement: false,
        trackKey,
        isPendingSwitch: true,
    });

    if (trackId) {
        const titleAlt = convertChineseTextToTraditional(title);
        const result = await window.electron?.smtc?.playSpotifyUri({
            uri: `spotify:track:${trackId}`,
            title,
            titleAlt,
            artist,
        });
        return Boolean(result?.ok);
    }

    const fallback = await window.electron?.smtc?.control({ action: 'play' });
    return Boolean(fallback?.ok);
};

export const activatePassiveSmtcTrack = (song: SongResult, startSec = 0): void => {
    if (!isSmtcSpotifySupported()) return;
    const title = song.name || '';
    const artist = getSongArtistLabel(song) || '';
    const durationSec = Math.max(0, (song.durationMs || 0) / 1000);
    pendingRequestedTrack = null;
    seekGuardUntilPerfMs = 0;
    syncSmtcClockAnchor(startSec, durationSec, false, { forceSnap: true });
    currentTime.set(Math.max(0, startSec));
    useSmtcSpotifyStore.setState({
        active: true,
        isExternalTrack: false,
        isAdvertisement: false,
        trackKey: buildSmtcTrackKey(title, artist),
    });
};

export const deactivateSmtc = (options?: { pauseExternal?: boolean }): void => {
    const wasActive = useSmtcSpotifyStore.getState().active;
    pendingRequestedTrack = null;
    seekGuardUntilPerfMs = 0;
    anchorIsPlaying = false;
    if (wasActive) {
        useSmtcSpotifyStore.setState({
            active: false,
            isExternalTrack: false,
            isAdvertisement: false,
        });
    }
    if (options?.pauseExternal && wasActive) {
        lastManualPauseAtMs = Date.now();
        void window.electron?.smtc?.control({ action: 'pause' });
    }
};

export const smtcPlay = async (): Promise<boolean> => {
    if (!isSmtcSpotifySupported()) return false;
    const state = useSmtcSpotifyStore.getState();
    const currentSong = usePlaybackStore.getState().currentSong;
    const trackId = extractSpotifyTrackId(currentSong);

    // If Spotify Desktop has no active session yet (e.g. cold-restored session) or holds a different song, launch the URI
    if (trackId && !state.isExternalTrack) {
        const liveStatus = await window.electron?.smtc?.getStatus().catch(() => null);
        const matchesLiveSession = Boolean(
            liveStatus?.hasSession
            && liveStatus.title
            && currentSong
            && doesSmtcTitleArtistMatch(
                liveStatus.title,
                liveStatus.artist,
                currentSong.name,
                getSongArtistLabel(currentSong),
            ),
        );
        if (!matchesLiveSession && currentSong) {
            return activateFoliaSpotifyTrack(currentSong);
        }
    }

    syncSmtcClockAnchor(getSmtcPositionSec(), anchorDurationSec, true, { forceSnap: true });
    const res = await window.electron?.smtc?.control({ action: 'play' });
    return Boolean(res?.ok);
};

export const smtcPause = async (): Promise<boolean> => {
    if (!isSmtcSpotifySupported()) return false;
    clearPendingRequestedSmtcTrack();
    lastManualPauseAtMs = Date.now();
    syncSmtcClockAnchor(getSmtcPositionSec(), anchorDurationSec, false, { forceSnap: true });
    const res = await window.electron?.smtc?.control({ action: 'pause' });
    return Boolean(res?.ok);
};

export const smtcToggle = async (): Promise<boolean> => {
    if (anchorIsPlaying) {
        return smtcPause();
    }
    return smtcPlay();
};

export const smtcNext = async (): Promise<boolean> => {
    if (!isSmtcSpotifySupported()) return false;
    clearPendingRequestedSmtcTrack();
    const res = await window.electron?.smtc?.control({ action: 'next' });
    return Boolean(res?.ok);
};

export const smtcPrevious = async (): Promise<boolean> => {
    if (!isSmtcSpotifySupported()) return false;
    clearPendingRequestedSmtcTrack();
    const res = await window.electron?.smtc?.control({ action: 'prev' });
    return Boolean(res?.ok);
};

export const seekSmtcRoute = (timeSec: number, options?: { resume?: boolean }): boolean => {
    if (!isSmtcRouteActive()) return false;
    const clampedSec = anchorDurationSec > 0
        ? Math.max(0, Math.min(timeSec, anchorDurationSec))
        : Math.max(0, timeSec);
    const wasPlaying = anchorIsPlaying;
    const shouldPlay = options?.resume ? true : wasPlaying;

    syncSmtcClockAnchor(clampedSec, anchorDurationSec, shouldPlay, { forceSnap: true });
    seekGuardUntilPerfMs = nowPerf() + 1300;
    currentTime.set(clampedSec);

    if (options?.resume) {
        setPlayerState(PlayerState.PLAYING);
    }

    const positionMs = Math.max(0, Math.round(clampedSec * 1000));
    void window.electron?.smtc?.control({
        action: 'seek',
        positionMs,
        resume: Boolean(options?.resume && !wasPlaying),
    });
    return true;
};
