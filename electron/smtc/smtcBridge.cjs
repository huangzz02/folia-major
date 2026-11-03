'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// electron/smtc/smtcBridge.cjs
// Safe Windows System Media Transport Controls (SMTC) bridge for Spotify Desktop,
// plus LRCLIB public lyrics lookup in the main process (free of renderer CSP limits).
// Purely uses standard Windows Runtime media APIs (GlobalSystemMediaTransportControlsSessionManager).
// Completely non-invasive: NO window hooks, NO keystroke simulation, NO token access.

const SPOTIFY_URI_RE = /^spotify:(track|album|playlist|artist):[0-9A-Za-z]{22}(:play)?$/;
const LRCLIB_BASE_URL = 'https://lrclib.net/api';
const LRCLIB_TIMEOUT_MS = 6500;
const LRCLIB_USER_AGENT = 'Folia/0.7.25 (https://github.com/chthollyphile/folia-major)';

const POWERSHELL_SMTC_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$helperCSharpCode = @'
using System;
using System.Collections.Concurrent;
using System.Threading;

public static class StdinReader {
    public static readonly ConcurrentQueue<string> Queue = new ConcurrentQueue<string>();
    public static volatile bool IsEof = false;
    private static Thread _thread;

    public static void Start() {
        _thread = new Thread(() => {
            try {
                string line;
                while ((line = Console.ReadLine()) != null) {
                    Queue.Enqueue(line);
                }
            } catch {
            } finally {
                IsEof = true;
            }
        });
        _thread.IsBackground = true;
        _thread.Start();
    }

    public static string TryRead() {
        string res;
        if (Queue.TryDequeue(out res)) return res;
        return null;
    }
}
'@

Add-Type -TypeDefinition $helperCSharpCode
[StdinReader]::Start()

$asStreamMethod = [System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsStreamForRead' -and $_.GetParameters().Count -eq 1
} | Select-Object -First 1

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]

function Await-WinRt($winRtOp, $resultType, $timeoutMs = 2500) {
    if ($null -eq $winRtOp) { return $null }
    try {
        $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
        $netTask = $asTask.Invoke($null, @($winRtOp))
        if ($netTask.Wait($timeoutMs)) {
            return $netTask.Result
        }
    } catch {}
    return $null
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

$manager = Await-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]) 5000

function Get-SpotifySession {
    if ($null -eq $manager) { return $null }
    try {
        $sessions = $manager.GetSessions()
        if ($null -ne $sessions) {
            foreach ($s in $sessions) {
                if ($s.SourceAppUserModelId -match 'Spotify') {
                    return $s
                }
            }
        }
    } catch {}
    return $null
}

function Read-ThumbnailDataUrl($thumbRef) {
    if ($null -eq $thumbRef -or $null -eq $asStreamMethod) { return $null }
    try {
        $winStream = Await-WinRt ($thumbRef.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType]) 2000
        if ($null -eq $winStream) { return $null }
        $netStream = $asStreamMethod.Invoke($null, @($winStream))
        if ($null -eq $netStream) { return $null }
        $ms = New-Object System.IO.MemoryStream
        $netStream.CopyTo($ms)
        $bytes = $ms.ToArray()
        $ms.Dispose()
        $netStream.Dispose()
        if ($bytes.Length -lt 16) { return $null }
        $mime = 'image/jpeg'
        if ($bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47) {
            $mime = 'image/png'
        } elseif ($bytes[0] -eq 0x52 -and $bytes[1] -eq 0x49 -and $bytes[2] -eq 0x46 -and $bytes[3] -eq 0x46) {
            $mime = 'image/webp'
        }
        $b64 = [Convert]::ToBase64String($bytes)
        return "data:$mime;base64,$b64"
    } catch {}
    return $null
}

$cachedTrackKey = ''
$cachedHasThumb = $false
$lastEmitSignature = ''
$lastEmitMs = [int64]0

function Emit-Json($obj) {
    try {
        $json = $obj | ConvertTo-Json -Compress -Depth 4
        [Console]::Out.WriteLine($json)
        [Console]::Out.Flush()
    } catch {}
}

function Poll-And-Emit($forceEmit = $false, $forceThumb = $false) {
    $nowEpochMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $session = Get-SpotifySession
    if ($null -eq $session) {
        $sig = 'NO_SESSION'
        if ($forceEmit -or $script:lastEmitSignature -ne $sig) {
            $script:lastEmitSignature = $sig
            $script:cachedTrackKey = ''
            $script:cachedHasThumb = $false
            $script:lastEmitMs = $nowEpochMs
            Emit-Json @{
                type = 'status'
                hasSession = $false
                appId = ''
                title = ''
                artist = ''
                album = ''
                duration = 0
                position = 0
                isPlaying = $false
                playbackStatus = 'Closed'
                timestamp = $nowEpochMs
            }
        }
        return $false
    }

    $props = Await-WinRt ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]) 1800
    $tl = $null
    $pb = $null
    try { $tl = $session.GetTimelineProperties() } catch {}
    try { $pb = $session.GetPlaybackInfo() } catch {}

    $title = if ($props -and $props.Title) { [string]$props.Title } else { '' }
    $artist = if ($props -and $props.Artist) { [string]$props.Artist } else { '' }
    $album = if ($props -and $props.AlbumTitle) { [string]$props.AlbumTitle } else { '' }
    $statusStr = if ($pb) { [string]$pb.PlaybackStatus } else { 'Unknown' }
    $isPlaying = ($statusStr -eq 'Playing' -or $statusStr -eq '4')

    $durMs = [int64]0
    $posMs = [int64]0
    if ($null -ne $tl) {
        $startMs = $tl.StartTime.TotalMilliseconds
        $endMs = $tl.EndTime.TotalMilliseconds
        $rawPosMs = $tl.Position.TotalMilliseconds - $startMs
        $spanMs = $endMs - $startMs
        if ($spanMs -gt 0) { $durMs = [int64][Math]::Round($spanMs) }
        $calcPos = [Math]::Max(0.0, $rawPosMs)
        if ($isPlaying -and $tl.LastUpdatedTime.Year -gt 2000) {
            $rate = if ($pb -and $pb.PlaybackRate -and $pb.PlaybackRate -gt 0) { [double]$pb.PlaybackRate } else { 1.0 }
            $elapsedMs = ([DateTimeOffset]::UtcNow - $tl.LastUpdatedTime).TotalMilliseconds
            if ($elapsedMs -gt 0 -and $elapsedMs -lt 3600000) {
                $calcPos += ($elapsedMs * $rate)
            }
        }
        if ($durMs -gt 0 -and $calcPos -gt $durMs) { $calcPos = [double]$durMs }
        $posMs = [int64][Math]::Round($calcPos)
    }

    $trackKey = "$title|$artist|$album"
    $thumbDataUrl = $null
    $needThumb = $forceThumb -or ($trackKey -ne $script:cachedTrackKey) -or (-not $script:cachedHasThumb -and $null -ne $props -and $null -ne $props.Thumbnail)
    if ($trackKey -ne $script:cachedTrackKey) {
        $script:cachedTrackKey = $trackKey
        $script:cachedHasThumb = $false
    }
    if ($needThumb -and $props -and $props.Thumbnail) {
        $thumbDataUrl = Read-ThumbnailDataUrl $props.Thumbnail
        if ($thumbDataUrl) {
            $script:cachedHasThumb = $true
        }
    }

    $sig = "$trackKey|$statusStr|$durMs"
    $intervalLimit = if ($isPlaying) { 280 } else { 1200 }
    $shouldEmit = $forceEmit -or ($null -ne $thumbDataUrl) -or ($sig -ne $script:lastEmitSignature) -or (($nowEpochMs - $script:lastEmitMs) -ge $intervalLimit)

    if ($shouldEmit) {
        $script:lastEmitSignature = $sig
        $script:lastEmitMs = $nowEpochMs
        $payload = @{
            type = 'status'
            hasSession = $true
            appId = [string]$session.SourceAppUserModelId
            title = $title
            artist = $artist
            album = $album
            duration = $durMs
            position = $posMs
            isPlaying = $isPlaying
            playbackStatus = $statusStr
            timestamp = $nowEpochMs
        }
        if ($null -ne $thumbDataUrl) {
            $payload['thumbnail'] = $thumbDataUrl
        }
        Emit-Json $payload
    }
    return $isPlaying
}

function Invoke-ControlCommand($line) {
    if ([string]::IsNullOrWhiteSpace($line)) { return }
    $cmd = $null
    try { $cmd = $line | ConvertFrom-Json } catch { return }
    if ($null -eq $cmd -or -not $cmd.action) { return }
    $action = [string]$cmd.action
    if ($action -eq 'refresh') {
        Poll-And-Emit $true $true | Out-Null
        return
    }
    $session = Get-SpotifySession
    if ($null -eq $session) { return }
    $postDelayMs = 60
    try {
        switch ($action) {
            'play' {
                Await-WinRt ($session.TryPlayAsync()) ([bool]) 1500 | Out-Null
            }
            'pause' {
                Await-WinRt ($session.TryPauseAsync()) ([bool]) 1500 | Out-Null
            }
            'toggle' {
                Await-WinRt ($session.TryTogglePlayPauseAsync()) ([bool]) 1500 | Out-Null
            }
            'next' {
                Await-WinRt ($session.TrySkipNextAsync()) ([bool]) 1500 | Out-Null
            }
            'prev' {
                Await-WinRt ($session.TrySkipPreviousAsync()) ([bool]) 1500 | Out-Null
            }
            'previous' {
                Await-WinRt ($session.TrySkipPreviousAsync()) ([bool]) 1500 | Out-Null
            }
            'seek' {
                $targetMs = [double]$cmd.positionMs
                if ($targetMs -lt 0) { $targetMs = 0 }
                $startTicks = [int64]0
                try {
                    $tl = $session.GetTimelineProperties()
                    if ($null -ne $tl) { $startTicks = $tl.StartTime.Ticks }
                } catch {}
                $targetTicks = $startTicks + [int64][Math]::Round($targetMs * 10000.0)
                Await-WinRt ($session.TryChangePlaybackPositionAsync($targetTicks)) ([bool]) 1500 | Out-Null
                if ($cmd.resume -eq $true) {
                    $alreadyPlaying = $false
                    try {
                        $pb = $session.GetPlaybackInfo()
                        if ($null -ne $pb -and $pb.PlaybackStatus.ToString() -eq 'Playing') {
                            $alreadyPlaying = $true
                        }
                    } catch {}
                    if (-not $alreadyPlaying) {
                        Await-WinRt ($session.TryPlayAsync()) ([bool]) 1500 | Out-Null
                    }
                }
                $postDelayMs = 160
            }
        }
    } catch {}
    Start-Sleep -Milliseconds $postDelayMs
    Poll-And-Emit $true $false | Out-Null
}

Poll-And-Emit $true $true | Out-Null

while ($true) {
    if ([StdinReader]::IsEof) { break }
    while ($true) {
        $cmdLine = [StdinReader]::TryRead()
        if ($null -eq $cmdLine) { break }
        Invoke-ControlCommand $cmdLine
    }
    $active = Poll-And-Emit $false $false
    $waitMs = if ($active) { 180 } else { 500 }
    Start-Sleep -Milliseconds $waitMs
}
`;

function normalizeSearchToken(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s*\((?:feat\.?|ft\.?|with|remaster(?:ed)?|live|deluxe|version)[^)]*\)/gi, '')
    .replace(/\s*-\s*(?:remaster(?:ed)?|single|mono|stereo|live).*$/gi, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

async function fetchJsonWithTimeout(fetchFn, url) {
  const response = await fetchFn(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': LRCLIB_USER_AGENT,
    },
    signal: AbortSignal.timeout(LRCLIB_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`LRCLIB HTTP ${response.status}`);
  }
  return await response.json();
}

async function queryLrclib(fetchFn, query) {
  if (!query || typeof query !== 'object') return null;
  const rawTitle = String(query.title || '').trim();
  const rawArtist = String(query.artist || '').trim();
  const rawAlbum = String(query.album || '').trim();
  const durationSec = Math.round(Number(query.durationSec) || 0);

  if (!rawTitle) return null;

  const normTitle = normalizeSearchToken(rawTitle);
  const normArtist = normalizeSearchToken(rawArtist);

  if (normTitle && durationSec > 0) {
    const getParams = new URLSearchParams({
      track_name: normTitle,
      duration: String(durationSec),
    });
    if (normArtist) getParams.set('artist_name', normArtist);
    if (rawAlbum) getParams.set('album_name', rawAlbum);

    try {
      const exact = await fetchJsonWithTimeout(fetchFn, `${LRCLIB_BASE_URL}/get?${getParams.toString()}`);
      if (exact && (exact.syncedLyrics || exact.plainLyrics)) {
        return exact;
      }
    } catch {}
  }

  const searchParams = new URLSearchParams({
    track_name: normTitle || rawTitle,
  });
  if (normArtist) searchParams.set('artist_name', normArtist);

  try {
    const list = await fetchJsonWithTimeout(fetchFn, `${LRCLIB_BASE_URL}/search?${searchParams.toString()}`);
    if (Array.isArray(list) && list.length > 0) {
      if (durationSec > 0) {
        const matched = list.find((item) => {
          if (!item.duration) return false;
          return Math.abs(Math.round(item.duration) - durationSec) <= 4;
        });
        if (matched && (matched.syncedLyrics || matched.plainLyrics)) {
          return matched;
        }
      }
      const firstWithSynced = list.find((item) => item.syncedLyrics);
      if (firstWithSynced) return firstWithSynced;
      const firstWithPlain = list.find((item) => item.plainLyrics);
      if (firstWithPlain) return firstWithPlain;
      return list[0];
    }
  } catch {}

  const genericParams = new URLSearchParams({
    q: `${normTitle} ${normArtist}`.trim(),
  });
  try {
    const genericList = await fetchJsonWithTimeout(fetchFn, `${LRCLIB_BASE_URL}/search?${genericParams.toString()}`);
    if (Array.isArray(genericList) && genericList.length > 0) {
      const firstWithSynced = genericList.find((item) => item.syncedLyrics);
      return firstWithSynced || genericList[0];
    }
  } catch {}

  return null;
}

function createSmtcBridge({
  platform = process.platform,
  openExternal,
  fetch: customFetch,
  broadcast,
  getFocusWindow,
  log = (...args) => console.log(...args),
  warn = (...args) => console.warn(...args),
} = {}) {
  const isSupported = platform === 'win32';
  const fetchFn = customFetch || globalThis.fetch;
  let child = null;
  let disposed = false;
  let restartTimer = null;
  let stdoutBuffer = '';
  let cachedTrackKey = '';
  let cachedThumbnail = null;
  let latestStatus = {
    hasSession: false,
    appId: '',
    title: '',
    artist: '',
    album: '',
    duration: 0,
    position: 0,
    isPlaying: false,
    playbackStatus: 'Closed',
    thumbnail: null,
    timestamp: Date.now(),
  };

  const handleStdoutLine = (rawLine) => {
    const trimmed = rawLine.trim();
    if (!trimmed || !trimmed.startsWith('{')) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!parsed || parsed.type !== 'status') return;

    const trackKey = parsed.hasSession
      ? `${parsed.title || ''}|${parsed.artist || ''}|${parsed.album || ''}`
      : '';

    if (trackKey !== cachedTrackKey) {
      cachedTrackKey = trackKey;
      cachedThumbnail = typeof parsed.thumbnail === 'string' ? parsed.thumbnail : null;
    } else if (typeof parsed.thumbnail === 'string' && parsed.thumbnail) {
      cachedThumbnail = parsed.thumbnail;
    }

    if (!parsed.hasSession) {
      cachedThumbnail = null;
    }

    latestStatus = {
      hasSession: Boolean(parsed.hasSession),
      appId: String(parsed.appId || ''),
      title: String(parsed.title || ''),
      artist: String(parsed.artist || ''),
      album: String(parsed.album || ''),
      duration: Math.max(0, Number(parsed.duration) || 0),
      position: Math.max(0, Number(parsed.position) || 0),
      isPlaying: Boolean(parsed.isPlaying),
      playbackStatus: String(parsed.playbackStatus || 'Unknown'),
      thumbnail: cachedThumbnail,
      timestamp: Number(parsed.timestamp) || Date.now(),
    };

    if (typeof broadcast === 'function') {
      broadcast(latestStatus);
    }
  };

  const writeStdinCommand = (payload) => {
    if (!child || !child.stdin || child.killed || !child.stdin.writable) {
      return false;
    }
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8');
      return true;
    } catch (err) {
      warn('[SMTC] Failed writing command to SMTC helper:', err?.message || err);
      return false;
    }
  };

  const spawnHelper = () => {
    if (!isSupported || disposed || child) return;
    try {
      const proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_SMTC_SCRIPT],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      child = proc;
      stdoutBuffer = '';

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk;
        let newlineIdx = stdoutBuffer.indexOf('\n');
        while (newlineIdx !== -1) {
          const line = stdoutBuffer.slice(0, newlineIdx);
          stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
          handleStdoutLine(line);
          newlineIdx = stdoutBuffer.indexOf('\n');
        }
      });

      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', () => {
        // Silenced non-fatal WinRT COM noise
      });

      proc.on('close', (code) => {
        if (child === proc) {
          child = null;
        }
        if (!disposed) {
          warn(`[SMTC] Helper exited (code ${code}), restarting in 2s...`);
          clearTimeout(restartTimer);
          restartTimer = setTimeout(spawnHelper, 2000);
          restartTimer.unref?.();
        }
      });

      proc.on('error', (err) => {
        warn('[SMTC] Helper spawn error:', err?.message || err);
      });

      log('[SMTC] Windows SMTC Spotify watcher started.');
    } catch (err) {
      warn('[SMTC] Failed to start PowerShell SMTC helper:', err?.message || err);
    }
  };

  const start = () => {
    if (!isSupported) return;
    disposed = false;
    spawnHelper();
  };

  const dispose = () => {
    disposed = true;
    clearTimeout(restartTimer);
    restartTimer = null;
    if (child) {
      const proc = child;
      child = null;
      try {
        proc.stdin?.end();
      } catch {}
      try {
        proc.kill();
      } catch {}
    }
  };

  const getStatus = () => {
    if (!isSupported) return null;
    if (!child && !disposed) spawnHelper();
    return latestStatus;
  };

  const control = async (command) => {
    if (!isSupported || !command || typeof command !== 'object') {
      return { ok: false, reason: 'unsupported' };
    }
    const allowedActions = new Set(['play', 'pause', 'toggle', 'next', 'prev', 'previous', 'seek', 'refresh']);
    const action = String(command.action || '');
    if (!allowedActions.has(action)) {
      return { ok: false, reason: 'invalid-action' };
    }
    if (!child && !disposed) {
      spawnHelper();
    }
    const sent = writeStdinCommand({
      action,
      ...(typeof command.positionMs === 'number' && Number.isFinite(command.positionMs)
        ? { positionMs: Math.max(0, Math.round(command.positionMs)) }
        : {}),
      ...(typeof command.resume === 'boolean' ? { resume: command.resume } : {}),
    });
    return { ok: sent };
  };

  const playSpotifyUri = async (input) => {
    const rawUri = typeof input === 'string'
      ? input
      : (input && typeof input === 'object' && typeof input.uri === 'string' ? input.uri : '');

    if (!rawUri || !SPOTIFY_URI_RE.test(rawUri.trim())) {
      return { ok: false, reason: 'invalid-spotify-uri' };
    }
    const cleanUri = rawUri.trim();
    const standardUri = cleanUri.replace(/:play$/, '');

    try {
      if (typeof openExternal === 'function') {
        await openExternal(standardUri);
        return { ok: true };
      }
      return { ok: false, reason: 'openExternal-not-available' };
    } catch (err) {
      warn('[SMTC] Failed launching Spotify URI:', err?.message || err);
      return { ok: false, reason: 'launch-failed' };
    }
  };

  const fetchLrclib = async (query) => {
    try {
      const data = await queryLrclib(fetchFn, query);
      return { ok: true, data };
    } catch (err) {
      warn('[SMTC/LRCLIB] Fetch failed:', err?.message || err);
      return { ok: false, data: null };
    }
  };

  return {
    isSupported,
    start,
    dispose,
    getStatus,
    control,
    playSpotifyUri,
    fetchLrclib,
  };
}

module.exports = {
  SPOTIFY_URI_RE,
  createSmtcBridge,
};
