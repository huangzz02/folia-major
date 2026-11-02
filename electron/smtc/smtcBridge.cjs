'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// electron/smtc/smtcBridge.cjs
// Windows System Media Transport Controls (SMTC) bidirectional bridge for Spotify Desktop,
// plus LRCLIB public lyrics lookup in the main process (free of renderer CSP limits).

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
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
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

public static class SpotifyTrackSwitchHelper {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr OpenWindowStation(string lpszWinSta, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll")]
    public static extern bool SetProcessWindowStation(IntPtr hWinSta);

    [DllImport("user32.dll")]
    public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll")]
    public static extern bool SetThreadDesktop(IntPtr hDesktop);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    private static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
    private static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_TOPMOST = 0x00000008;
    private const int SW_SHOWNOACTIVATE = 4;
    private const uint WM_ACTIVATE = 0x0006;
    private const uint WM_SETFOCUS = 0x0007;
    private const uint WM_KEYDOWN = 0x0100;
    private const uint WM_KEYUP = 0x0101;
    private const int VK_RETURN = 0x0D;

    private static readonly object _stateLock = new object();
    private static bool _liveHasSession = false;
    private static string _liveTitle = "";
    private static string _liveArtist = "";
    private static bool _liveIsPlaying = false;

    private static readonly object _pinLock = new object();
    private static IntPtr _pinnedFgHwnd = IntPtr.Zero;
    private static bool _pinnedWasTopmost = false;

    private static int _requestToken = 0;
    private static int _activeSwitches = 0;
    private static int _pendingSmtcPlay = 0;

    public static void UpdateLiveSmtc(bool hasSession, string title, string artist, bool isPlaying) {
        lock (_stateLock) {
            _liveHasSession = hasSession;
            _liveTitle = title ?? "";
            _liveArtist = artist ?? "";
            _liveIsPlaying = isPlaying;
        }
    }

    public static bool IsSwitching() {
        return Volatile.Read(ref _activeSwitches) > 0;
    }

    public static bool ConsumePendingSmtcPlay() {
        return Interlocked.Exchange(ref _pendingSmtcPlay, 0) == 1;
    }

    private static string NormalizeToken(string input) {
        if (string.IsNullOrWhiteSpace(input)) return "";
        string s = input.Trim().ToLowerInvariant();
        var sb = new StringBuilder(s.Length);
        bool prevSpace = true;
        for (int i = 0; i < s.Length; i++) {
            char ch = s[i];
            if (char.IsLetterOrDigit(ch)) {
                sb.Append(ch);
                prevSpace = false;
            } else if (!prevSpace) {
                sb.Append(' ');
                prevSpace = true;
            }
        }
        return sb.ToString().Trim();
    }

    private static string GetCoreTitle(string input) {
        if (string.IsNullOrWhiteSpace(input)) return "";
        string c = input.Trim();
        char[] openBrackets = new char[] { '(', '[', (char)0xFF08, (char)0x3010 };
        int bIdx = c.IndexOfAny(openBrackets);
        if (bIdx > 0) c = c.Substring(0, bIdx).Trim();
        int dashIdx = c.IndexOf(" - ", StringComparison.Ordinal);
        if (dashIdx > 0) c = c.Substring(0, dashIdx).Trim();
        return NormalizeToken(c);
    }

    private static string GetPrimaryArtist(string input) {
        if (string.IsNullOrWhiteSpace(input)) return "";
        string c = input.Trim();
        string[] seps = new string[] { ",", "/", "&", ";", "\u3001", " feat.", " feat ", " ft.", " ft " };
        int earliest = -1;
        for (int i = 0; i < seps.Length; i++) {
            int idx = c.IndexOf(seps[i], StringComparison.OrdinalIgnoreCase);
            if (idx > 0 && (earliest < 0 || idx < earliest)) {
                earliest = idx;
            }
        }
        if (earliest > 0) c = c.Substring(0, earliest).Trim();
        return NormalizeToken(c);
    }

    public static bool TitleMatches(string actualTitle, string expectedTitle, string expectedTitleAlt) {
        string aNorm = NormalizeToken(actualTitle);
        if (string.IsNullOrEmpty(aNorm)) return false;
        string aCore = GetCoreTitle(actualTitle);

        string[] candidates = new string[] { expectedTitle, expectedTitleAlt };
        for (int i = 0; i < candidates.Length; i++) {
            string cand = candidates[i];
            if (string.IsNullOrWhiteSpace(cand)) continue;
            string eNorm = NormalizeToken(cand);
            if (!string.IsNullOrEmpty(eNorm)) {
                if (aNorm == eNorm) return true;
                if (aNorm.Length >= 2 && eNorm.Length >= 2 && (aNorm.Contains(eNorm) || eNorm.Contains(aNorm))) return true;
            }
            string eCore = GetCoreTitle(cand);
            if (!string.IsNullOrEmpty(eCore) && eCore.Length >= 2) {
                if (aCore == eCore || aNorm.Contains(eCore) || eCore.Contains(aNorm)) return true;
            }
        }
        return false;
    }

    public static bool ArtistMatches(string actualArtist, string expectedArtist) {
        string aNorm = NormalizeToken(actualArtist);
        string eNorm = NormalizeToken(expectedArtist);
        if (string.IsNullOrEmpty(aNorm) || string.IsNullOrEmpty(eNorm)) return true;
        if (aNorm == eNorm || aNorm.Contains(eNorm) || eNorm.Contains(aNorm)) return true;
        string aPrim = GetPrimaryArtist(actualArtist);
        string ePrim = GetPrimaryArtist(expectedArtist);
        if (!string.IsNullOrEmpty(aPrim) && !string.IsNullOrEmpty(ePrim)) {
            if (aPrim == ePrim || aPrim.Contains(ePrim) || ePrim.Contains(aPrim)) return true;
        }
        return false;
    }

    public static bool IsAlreadyCurrentTrack(string title, string titleAlt, string artist) {
        if (string.IsNullOrWhiteSpace(title) && string.IsNullOrWhiteSpace(titleAlt)) return false;
        bool hasSess;
        string curTitle;
        string curArtist;
        lock (_stateLock) {
            hasSess = _liveHasSession;
            curTitle = _liveTitle;
            curArtist = _liveArtist;
        }
        if (!hasSess || string.IsNullOrWhiteSpace(curTitle)) return false;
        return TitleMatches(curTitle, title, titleAlt) && ArtistMatches(curArtist, artist);
    }

    private static void BindInteractiveDesktop() {
        try {
            IntPtr hWinsta = OpenWindowStation("WinSta0", false, 0x10000000);
            if (hWinsta != IntPtr.Zero) SetProcessWindowStation(hWinsta);
            IntPtr hDesk = OpenDesktop("Default", 0, false, 0x10000000);
            if (hDesk != IntPtr.Zero) SetThreadDesktop(hDesk);
        } catch {}
    }

    private static string GetClass(IntPtr hWnd) {
        var sb = new StringBuilder(256);
        GetClassName(hWnd, sb, 256);
        return sb.ToString();
    }

    private static string GetTitle(IntPtr hWnd) {
        var sb = new StringBuilder(512);
        GetWindowText(hWnd, sb, 512);
        return sb.ToString();
    }

    public static IntPtr FindSpotifyTopWindow() {
        try {
            var pids = new HashSet<uint>();
            Process[] procs = Process.GetProcessesByName("Spotify");
            for (int i = 0; i < procs.Length; i++) {
                pids.Add((uint)procs[i].Id);
            }
            if (pids.Count == 0) return IntPtr.Zero;

            IntPtr visibleFound = IntPtr.Zero;
            IntPtr hiddenFound = IntPtr.Zero;

            EnumWindows((hWnd, lParam) => {
                uint procId;
                GetWindowThreadProcessId(hWnd, out procId);
                if (!pids.Contains(procId)) return true;
                if (GetClass(hWnd) != "Chrome_WidgetWin_1") return true;
                string ttl = GetTitle(hWnd);
                if (string.IsNullOrEmpty(ttl)) return true;

                if (IsWindowVisible(hWnd)) {
                    visibleFound = hWnd;
                    return false;
                }
                if (hiddenFound == IntPtr.Zero) {
                    hiddenFound = hWnd;
                }
                return true;
            }, IntPtr.Zero);

            return visibleFound != IntPtr.Zero ? visibleFound : hiddenFound;
        } catch {
            return IntPtr.Zero;
        }
    }

    private static void RestoreForeground(IntPtr targetHwnd) {
        if (targetHwnd == IntPtr.Zero || !IsWindow(targetHwnd)) return;
        if (GetForegroundWindow() == targetHwnd) return;
        try {
            keybd_event(0, 0, 0, UIntPtr.Zero);
            SetForegroundWindow(targetHwnd);
        } catch {}
    }

    private static void SendFakeFocusEnter(IntPtr spTop) {
        if (spTop == IntPtr.Zero || !IsWindow(spTop)) return;
        IntPtr downLParam = new IntPtr(0x001C0001);
        IntPtr upLParam = unchecked((IntPtr)(int)0xC01C0001);
        SendMessage(spTop, WM_ACTIVATE, new IntPtr(1), IntPtr.Zero);
        SendMessage(spTop, WM_SETFOCUS, IntPtr.Zero, IntPtr.Zero);
        PostMessage(spTop, WM_KEYDOWN, new IntPtr(VK_RETURN), downLParam);
        PostMessage(spTop, WM_KEYUP, new IntPtr(VK_RETURN), upLParam);
    }

    private static void LaunchProtocolUri(string uri, string spotifyExePath) {
        if (!string.IsNullOrWhiteSpace(spotifyExePath) && File.Exists(spotifyExePath)) {
            try {
                var psi = new ProcessStartInfo(spotifyExePath, "--protocol-uri=" + uri);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process.Start(psi);
                return;
            } catch {}
        }
        try {
            var psiFallback = new ProcessStartInfo(uri);
            psiFallback.UseShellExecute = true;
            Process.Start(psiFallback);
        } catch {}
    }

    private static void SwitchAndPlayTrack(string uri, string spotifyExePath, string title, string titleAlt, string artist, int myToken) {
        Interlocked.Increment(ref _activeSwitches);
        BindInteractiveDesktop();

        bool initHasSession;
        string initTitle;
        string initArtist;
        lock (_stateLock) {
            initHasSession = _liveHasSession;
            initTitle = _liveTitle;
            initArtist = _liveArtist;
        }
        string initKey = NormalizeToken(initTitle) + "|" + NormalizeToken(initArtist);

        IntPtr spHwnd = FindSpotifyTopWindow();
        IntPtr fgNow = GetForegroundWindow();
        IntPtr protectedFg = IntPtr.Zero;

        lock (_pinLock) {
            if (_pinnedFgHwnd == IntPtr.Zero && fgNow != IntPtr.Zero && fgNow != spHwnd) {
                _pinnedFgHwnd = fgNow;
                _pinnedWasTopmost = (GetWindowLong(fgNow, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
                SetWindowPos(fgNow, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
            protectedFg = _pinnedFgHwnd;
        }

        try {
            if (Volatile.Read(ref _requestToken) != myToken) return;

            bool wasColdStart = (spHwnd == IntPtr.Zero);

            // Wake Chromium from hidden/minimized state before --protocol-uri arrives so Spotify focuses the target track row
            if (spHwnd != IntPtr.Zero && (!IsWindowVisible(spHwnd) || IsIconic(spHwnd))) {
                ShowWindow(spHwnd, SW_SHOWNOACTIVATE);
                SetWindowPos(spHwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                Thread.Sleep(165);
                if (Volatile.Read(ref _requestToken) != myToken) return;
            }

            if (!string.IsNullOrWhiteSpace(uri)) {
                LaunchProtocolUri(uri, spotifyExePath);
            }

            int timeoutMs = wasColdStart ? 6800 : 3900;
            int[] enterSchedule = wasColdStart
                ? new int[] { 1250, 2000, 2850, 3850, 4950 }
                : new int[] { 460, 980, 1650, 2450, 3250 };
            int nextEnterIdx = 0;
            long switchedDetectedAtMs = -1;
            var sw = Stopwatch.StartNew();

            while (sw.ElapsedMilliseconds < timeoutMs) {
                Thread.Sleep(65);
                if (Volatile.Read(ref _requestToken) != myToken) return;

                if (protectedFg != IntPtr.Zero && sw.ElapsedMilliseconds >= 140 && GetForegroundWindow() != protectedFg) {
                    RestoreForeground(protectedFg);
                }

                bool curHasSession;
                string curTitle;
                string curArtist;
                bool curPlaying;
                lock (_stateLock) {
                    curHasSession = _liveHasSession;
                    curTitle = _liveTitle;
                    curArtist = _liveArtist;
                    curPlaying = _liveIsPlaying;
                }

                string curKey = NormalizeToken(curTitle) + "|" + NormalizeToken(curArtist);
                bool isStillInitialTrack = initHasSession
                    && !string.IsNullOrWhiteSpace(initTitle)
                    && string.Equals(curKey, initKey, StringComparison.OrdinalIgnoreCase);

                bool hasExpectedMetadata = !string.IsNullOrWhiteSpace(title) || !string.IsNullOrWhiteSpace(titleAlt);
                bool matchesTarget = hasExpectedMetadata
                    && curHasSession
                    && !string.IsNullOrWhiteSpace(curTitle)
                    && TitleMatches(curTitle, title, titleAlt)
                    && ArtistMatches(curArtist, artist);

                bool switchedAfterEnter = nextEnterIdx > 0
                    && curHasSession
                    && !string.IsNullOrWhiteSpace(curTitle)
                    && !isStillInitialTrack;

                if ((!isStillInitialTrack && matchesTarget) || switchedAfterEnter) {
                    if (curPlaying) {
                        break;
                    }
                    if (switchedDetectedAtMs < 0) {
                        switchedDetectedAtMs = sw.ElapsedMilliseconds;
                    } else if (sw.ElapsedMilliseconds - switchedDetectedAtMs >= 220) {
                        Interlocked.Exchange(ref _pendingSmtcPlay, 1);
                        switchedDetectedAtMs = sw.ElapsedMilliseconds;
                    }
                    continue;
                }

                if (nextEnterIdx < enterSchedule.Length && sw.ElapsedMilliseconds >= enterSchedule[nextEnterIdx]) {
                    spHwnd = FindSpotifyTopWindow();
                    if (spHwnd != IntPtr.Zero) {
                        if (!IsWindowVisible(spHwnd) || IsIconic(spHwnd)) {
                            ShowWindow(spHwnd, SW_SHOWNOACTIVATE);
                            SetWindowPos(spHwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                            Thread.Sleep(90);
                        }
                        SendFakeFocusEnter(spHwnd);
                        if (protectedFg != IntPtr.Zero) {
                            Thread.Sleep(25);
                            RestoreForeground(protectedFg);
                        }
                        nextEnterIdx++;
                    }
                }
            }
        } finally {
            Interlocked.Decrement(ref _activeSwitches);
            if (Volatile.Read(ref _requestToken) == myToken) {
                IntPtr toRestore = IntPtr.Zero;
                bool wasTopmost = false;
                lock (_pinLock) {
                    toRestore = _pinnedFgHwnd;
                    wasTopmost = _pinnedWasTopmost;
                    _pinnedFgHwnd = IntPtr.Zero;
                    _pinnedWasTopmost = false;
                }
                if (toRestore != IntPtr.Zero && IsWindow(toRestore)) {
                    RestoreForeground(toRestore);
                    if (!wasTopmost) {
                        SetWindowPos(toRestore, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                    }
                }
            }
        }
    }

    public static void TriggerPlayInBackground(string uri, string spotifyExePath, string title, string titleAlt, string artist) {
        int token = Interlocked.Increment(ref _requestToken);
        var t = new Thread(() => {
            SwitchAndPlayTrack(uri, spotifyExePath, title, titleAlt, artist, token);
        });
        t.IsBackground = true;
        t.Start();
    }
}
'@
Add-Type -TypeDefinition $helperCSharpCode -Language CSharp
[StdinReader]::Start()

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]

$asStreamMethod = ([System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsStreamForRead' -and $_.GetParameters().Count -eq 1
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
        [SpotifyTrackSwitchHelper]::UpdateLiveSmtc($false, '', '', $false)
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

    [SpotifyTrackSwitchHelper]::UpdateLiveSmtc($true, $title, $artist, $isPlaying)

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
    if ($action -eq 'play_track') {
        $trackUri = if ($null -ne $cmd.uri) { [string]$cmd.uri } else { '' }
        $trackTitle = if ($null -ne $cmd.title) { [string]$cmd.title } else { '' }
        $trackTitleAlt = if ($null -ne $cmd.titleAlt) { [string]$cmd.titleAlt } else { '' }
        $trackArtist = if ($null -ne $cmd.artist) { [string]$cmd.artist } else { '' }
        $spotifyExe = if ($null -ne $cmd.spotifyExe) { [string]$cmd.spotifyExe } else { '' }
        try {
            [SpotifyTrackSwitchHelper]::TriggerPlayInBackground($trackUri, $spotifyExe, $trackTitle, $trackTitleAlt, $trackArtist)
        } catch {}
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
    if ([SpotifyTrackSwitchHelper]::ConsumePendingSmtcPlay()) {
        $s = Get-SpotifySession
        if ($null -ne $s) {
            Await-WinRt ($s.TryPlayAsync()) ([bool]) 800 | Out-Null
        }
    }
    $active = Poll-And-Emit $false $false
    $isSwitching = [SpotifyTrackSwitchHelper]::IsSwitching()
    $waitMs = if ($isSwitching) { 50 } elseif ($active) { 180 } else { 400 }
    Start-Sleep -Milliseconds $waitMs
}
`;

function resolveLocalSpotifyExecutable() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'Spotify', 'Spotify.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'Spotify.exe'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

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
  const title = typeof query?.title === 'string' ? query.title.trim() : '';
  const artist = typeof query?.artist === 'string' ? query.artist.trim() : '';
  const album = typeof query?.album === 'string' ? query.album.trim() : '';
  const durationSec = typeof query?.durationSec === 'number' && Number.isFinite(query.durationSec) && query.durationSec > 0
    ? Math.round(query.durationSec)
    : 0;

  if (!title) return null;
  const primaryArtist = artist.split(/[,;/、&]/)[0]?.trim() || artist;

  // 1. Exact /get lookup with full metadata
  try {
    const params = new URLSearchParams({ track_name: title, artist_name: artist || primaryArtist });
    if (album) params.set('album_name', album);
    if (durationSec > 0) params.set('duration', String(durationSec));
    const exact = await fetchJsonWithTimeout(fetchFn, `${LRCLIB_BASE_URL}/get?${params.toString()}`);
    if (exact && (typeof exact.syncedLyrics === 'string' && exact.syncedLyrics.trim() || exact.instrumental === true)) {
      return {
        id: exact.id ?? null,
        trackName: exact.trackName ?? title,
        artistName: exact.artistName ?? artist,
        duration: exact.duration ?? durationSec,
        instrumental: Boolean(exact.instrumental),
        syncedLyrics: typeof exact.syncedLyrics === 'string' ? exact.syncedLyrics : null,
        plainLyrics: typeof exact.plainLyrics === 'string' ? exact.plainLyrics : null,
      };
    }
  } catch {
    // Fall through to search
  }

  // 2. Flexible /search lookup
  const searchAttempts = [
    new URLSearchParams({ track_name: title, ...(primaryArtist ? { artist_name: primaryArtist } : {}) }),
    new URLSearchParams({ q: `${title} ${primaryArtist}`.trim() }),
  ];

  const targetTitle = normalizeSearchToken(title);
  const targetArtist = normalizeSearchToken(primaryArtist);

  for (const params of searchAttempts) {
    let rows = null;
    try {
      rows = await fetchJsonWithTimeout(fetchFn, `${LRCLIB_BASE_URL}/search?${params.toString()}`);
    } catch {
      rows = null;
    }
    if (!Array.isArray(rows) || rows.length === 0) continue;

    let bestRow = null;
    let bestScore = -Infinity;
    for (const row of rows) {
      const hasSynced = typeof row?.syncedLyrics === 'string' && row.syncedLyrics.trim().length > 0;
      if (!hasSynced && !row?.instrumental) continue;

      let score = hasSynced ? 100 : 10;
      const rowTitle = normalizeSearchToken(row.trackName || row.name);
      const rowArtist = normalizeSearchToken(row.artistName);

      if (rowTitle === targetTitle) score += 60;
      else if (rowTitle && targetTitle && (rowTitle.includes(targetTitle) || targetTitle.includes(rowTitle))) score += 35;

      if (targetArtist) {
        if (rowArtist === targetArtist) score += 50;
        else if (rowArtist && (rowArtist.includes(targetArtist) || targetArtist.includes(rowArtist))) score += 30;
        else score -= 25;
      }

      if (durationSec > 0 && typeof row.duration === 'number' && row.duration > 0) {
        const diff = Math.abs(row.duration - durationSec);
        if (diff <= 2) score += 40;
        else if (diff <= 5) score += 20;
        else if (diff <= 12) score += 0;
        else score -= Math.min(80, diff * 2);
      }

      if (score > bestScore) {
        bestScore = score;
        bestRow = row;
      }
    }

    if (bestRow && bestScore >= 95) {
      return {
        id: bestRow.id ?? null,
        trackName: bestRow.trackName ?? title,
        artistName: bestRow.artistName ?? artist,
        duration: bestRow.duration ?? durationSec,
        instrumental: Boolean(bestRow.instrumental),
        syncedLyrics: typeof bestRow.syncedLyrics === 'string' ? bestRow.syncedLyrics : null,
        plainLyrics: typeof bestRow.plainLyrics === 'string' ? bestRow.plainLyrics : null,
      };
    }
  }

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
    const allowedActions = new Set(['play', 'pause', 'toggle', 'next', 'prev', 'previous', 'seek', 'refresh', 'play_track']);
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
      ...(typeof command.uri === 'string' ? { uri: command.uri } : {}),
      ...(typeof command.title === 'string' ? { title: command.title } : {}),
      ...(typeof command.titleAlt === 'string' ? { titleAlt: command.titleAlt } : {}),
      ...(typeof command.artist === 'string' ? { artist: command.artist } : {}),
      ...(typeof command.spotifyExe === 'string' ? { spotifyExe: command.spotifyExe } : {}),
    });
    return { ok: sent };
  };

  const playSpotifyUri = async (input) => {
    const rawUri = typeof input === 'string'
      ? input
      : (input && typeof input === 'object' && typeof input.uri === 'string' ? input.uri : '');
    const title = input && typeof input === 'object' && typeof input.title === 'string' ? input.title.trim() : '';
    const titleAlt = input && typeof input === 'object' && typeof input.titleAlt === 'string' ? input.titleAlt.trim() : '';
    const artist = input && typeof input === 'object' && typeof input.artist === 'string' ? input.artist.trim() : '';

    if (!rawUri || !SPOTIFY_URI_RE.test(rawUri.trim())) {
      return { ok: false, reason: 'invalid-spotify-uri' };
    }
    const cleanUri = rawUri.trim();
    const standardUri = cleanUri.replace(/:play$/, '');
    const spotifyExe = isSupported ? resolveLocalSpotifyExecutable() : null;

    try {
      if (isSupported) {
        if (!child && !disposed) {
          spawnHelper();
        }
        const delegated = writeStdinCommand({
          action: 'play_track',
          uri: standardUri,
          title,
          titleAlt: titleAlt || title,
          artist,
          spotifyExe: spotifyExe || '',
        });
        if (delegated) {
          for (const delayMs of [550, 1100, 1900]) {
            setTimeout(() => {
              writeStdinCommand({ action: 'refresh' });
            }, delayMs).unref?.();
          }
          return { ok: true };
        }
      }

      let launched = false;
      if (typeof openExternal === 'function') {
        try {
          await openExternal(standardUri);
          launched = true;
        } catch (openErr) {
          warn('[SMTC] openExternal failed, falling back to executable spawn:', openErr?.message || openErr);
        }
      }

      if (!launched && spotifyExe) {
        const launcher = spawn(spotifyExe, [`--protocol-uri=${standardUri}`], {
          detached: true,
          stdio: 'ignore',
        });
        launcher.unref();
        launched = true;
      }

      if (!launched) {
        return { ok: false, reason: 'spotify-not-found' };
      }

      return { ok: true };
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
