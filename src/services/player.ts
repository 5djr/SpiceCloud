import { SCTrack } from "../types/soundcloud";
import { getTrackStreams, resolveTranscodingUrl } from "./api";

export interface PlayerState {
  track: SCTrack | null;
  isPlaying: boolean;
  position: number; // 0-1
  duration: number; // seconds
  volume: number;
  isLoading: boolean;
  error: string | null;
}

type Listener = (state: PlayerState) => void;

// ── Spotify DOM selectors ─────────────────────────────────────────────────────
const SEL_TITLE = [
  ".main-trackInfo-name",
  '[data-testid="context-item-info-title"]',
  ".now-playing__name",
];
const SEL_ARTIST = [
  ".main-trackInfo-artists",
  '[data-testid="context-item-info-subtitles"]',
  ".now-playing__artist",
];
const SEL_COVER = [
  ".main-coverSlotCollapsed-container img",
  '[data-testid="cover-art-image"]',
  ".cover-art-image",
];
const SEL_POS_TEXT = [
  '[data-testid="playback-position"]',
  ".playback-progressbar__time-elapsed",
];
const SEL_DUR_TEXT = [
  '[data-testid="playback-duration"]',
  ".playback-progressbar__time-total",
];
const SEL_PROGRESS = [
  '[data-testid="playback-progressbar"] input[type="range"]',
  '.playback-progressbar input[type="range"]',
  'input[aria-label*="progress" i]',
];
const SEL_VOLUME = [
  '[data-testid="volume-bar"] input[type="range"]',
  'input[aria-label*="volume" i]',
  'input[aria-label*="Lautstärke" i]',
  'input[aria-label*="Volumen" i]',
  '.volume-bar input[type="range"]',
];
const SEL_SKIP_FWD = [
  '[data-testid="control-button-skip-forward"]',
  'button[aria-label*="Next" i]',
];
const SEL_SKIP_BCK = [
  '[data-testid="control-button-skip-back"]',
  'button[aria-label*="Previous" i]',
];

function q<T extends Element = Element>(sels: string[]): T | null {
  for (const s of sels) {
    const el = document.querySelector<T>(s);
    if (el) return el;
  }
  return null;
}

function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60),
    sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

const nativeRangeSet = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "value",
)?.set;

// Pause-icon SVG as data-URL for CSS mask (matches Spotify's icon style).
const PAUSE_ICON_URL =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M2.7 1a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7H2.7zm8 0a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-2.6z'/%3E%3C/svg%3E\")";

class SoundCloudPlayer {
  private audio: HTMLAudioElement;
  private _track: SCTrack | null = null;
  private _isLoading = false;
  private _error: string | null = null;
  private _loadId = 0;
  private queue: SCTrack[] = [];
  private queueIndex = -1;
  private listeners: Set<Listener> = new Set();
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  // Reset by songchange to ensure any lingering echo is not acted on.
  private _selfPausingSpotify = false;
  private _sourceBadge: HTMLElement | null = null;
  private _tryHookSkipButtons: (() => void) | null = null;
  // Seek guard — when user is dragging the progress bar we must not overwrite
  // the range input's value or the thumb snaps back every 250 ms.
  private _isSeeking = false;

  constructor() {
    this.audio = document.createElement("audio");
    this.audio.id = "spicecloud-audio";
    document.body.appendChild(this.audio);
    this.bindAudioEvents();
    this.injectStyles();
    this.waitForSpicetify();
  }

  private waitForSpicetify(): void {
    if (
      typeof Spicetify === "undefined" ||
      !Spicetify.Player ||
      !Spicetify.Platform
    ) {
      setTimeout(() => this.waitForSpicetify(), 100);
      return;
    }
    this.hookSpotifyPlayer();
    this.hookSkipButtons();
    this.hookProgressBar();
  }

  // ── Audio events ──────────────────────────────────────────────────────────

  private bindAudioEvents(): void {
    this.audio.addEventListener("play", () => {
      document.body.classList.add("sc-playing");
      this.startTimer();
      this.emit();
    });
    this.audio.addEventListener("pause", () => {
      document.body.classList.remove("sc-playing");
      // Do NOT stop the timer here — the mute loop must keep running while
      // _track is set so Spotify's audio stays silent even when SC is paused.
      // stopTimer() is called only when _track is cleared (songchange / destroy).
      this.emit();
    });
    this.audio.addEventListener("play", () => {
      if (this._track) this.updateSourceBadge("soundcloud");
    });
    this.audio.addEventListener("pause", () => {
      if (!this._isLoading) this.updateSourceBadge(null);
    });
    this.audio.addEventListener("ended", () => {
      this.updateSourceBadge(null);
      void this.next();
    });
    this.audio.addEventListener("loadedmetadata", () => this.emit());
    this.audio.addEventListener("volumechange", () => this.emit());
    this.audio.addEventListener("error", () => {
      this._isLoading = false;
      this._error = "Stream error — track may be unavailable";
      this.emit();
    });
  }

  // ── Spotify muting ────────────────────────────────────────────────────────
  //
  // We mute every <audio> that isn't ours as a safety measure to prevent any
  // Spotify audio from leaking through. Spotify itself stays paused (so its
  // track position doesn't advance), and its button state is handled by CSS.

  private muteSpotifyAudio(muted: boolean): void {
    try {
      document.querySelectorAll<HTMLAudioElement>("audio").forEach((el) => {
        if (el !== this.audio) el.muted = muted;
      });
    } catch {}
  }

  // ── Spotify integration ───────────────────────────────────────────────────

  private hookSpotifyPlayer(): void {
    try {
      // ── Play / Pause ──────────────────────────────────────────────────────
      //
      // We treat every onplaypause event as a user toggle of SC audio.
      // The button visual is handled by CSS (body.sc-playing + mask).
      //
      // We do NOT call Spicetify.Player.pause() here — it caused a hard crash
      // when onplaypause fires mid-track-switch before songchange completes.
      // Instead: immediately re-mute Spotify audio and sync volume on every
      // resume so there is no audible bleed from Spotify's track.
      Spicetify.Player.addEventListener("onplaypause", () => {
        try {
          if (!this._track || this._isLoading) return;
          if (this.audio.paused) {
            this.muteSpotifyAudio(true);
            this.syncSpotifyVolume();
            void this.audio.play().catch(() => {});
          } else {
            this.audio.pause();
          }
        } catch {}
      });

      // ── Volume sync ───────────────────────────────────────────────────────
      for (const n of ["onvolumechange", "volumechange"]) {
        try {
          Spicetify.Player.addEventListener(n, () => {
            if (!this._track) return;
            this.syncSpotifyVolume();
          });
        } catch {}
      }

      // ── Next / Previous ───────────────────────────────────────────────────
      const doNext = () => {
        if (this._track) void this.next();
      };
      const doPrev = () => {
        if (this._track) void this.prev();
      };
      for (const n of ["forward", "next", "skipNext"]) {
        try {
          Spicetify.Player.addEventListener(n, doNext);
        } catch {}
      }
      for (const n of ["backward", "prev", "skipPrev"]) {
        try {
          Spicetify.Player.addEventListener(n, doPrev);
        } catch {}
      }

      // ── Seek ──────────────────────────────────────────────────────────────
      for (const n of ["onseek", "seek"]) {
        try {
          Spicetify.Player.addEventListener(n, () => {
            if (!this._track) return;
            const pos = Spicetify.Player.data?.position;
            if (typeof pos === "number" && pos >= 0)
              this.audio.currentTime = pos / 1000;
          });
        } catch {}
      }

      // ── Song change — Spotify navigated away ──────────────────────────────
      Spicetify.Player.addEventListener("songchange", () => {
        try {
          if (!this._track) return;
          // Increment loadId to abort any in-flight loadTrack promise.
          // Without this, a resolveStreamUrl() still in-flight would continue
          // after this handler clears _track, set sc-active again, and restart
          // SC audio on top of Spotify — causing the hard crash.
          this._loadId++;
          this.audio.pause();
          this._track = null;
          this._error = null;
          this._selfPausingSpotify = false;
          this.stopTimer();
          this.muteSpotifyAudio(false);
          this.updateSourceBadge(null);
          document.body.classList.remove("sc-active", "sc-playing");
          this.emit();
        } catch {}
      });
    } catch {
      // Spicetify.Player unavailable (running outside Spicetify).
    }
  }

  // ── Skip-button intercept ─────────────────────────────────────────────────

  private hookSkipButtons(): void {
    const hookBtn = (sels: string[], handler: () => void) => {
      for (const sel of sels) {
        const btn = document.querySelector<HTMLButtonElement>(sel);
        if (!btn || (btn as HTMLButtonElement & { _sc?: boolean })._sc)
          continue;
        (btn as HTMLButtonElement & { _sc?: boolean })._sc = true;
        btn.addEventListener(
          "click",
          (e) => {
            if (!this._track) return;
            e.stopImmediatePropagation();
            e.preventDefault();
            handler();
          },
          true,
        );
        return;
      }
    };
    const tryHook = () => {
      hookBtn(SEL_SKIP_FWD, () => void this.next());
      hookBtn(SEL_SKIP_BCK, () => void this.prev());
    };
    this._tryHookSkipButtons = tryHook;
    tryHook();
    [500, 1500, 4000, 10000].forEach((ms) => setTimeout(tryHook, ms));
  }

  // ── Progress bar seek intercept ───────────────────────────────────────────
  //
  // syncSpotifyProgress() writes the range input's value every 250 ms via the
  // native setter.  Without a guard, a user drag would snap back immediately.
  // We hook mousedown/touchstart to set _isSeeking=true (pausing our writes),
  // and mouseup/touchend to apply the seek and release the guard.

  private hookProgressBar(): void {
    const tryHook = () => {
      const inp = q<HTMLInputElement>(SEL_PROGRESS);
      if (!inp || (inp as HTMLInputElement & { _scSeek?: boolean })._scSeek)
        return;
      (inp as HTMLInputElement & { _scSeek?: boolean })._scSeek = true;

      const onStart = () => {
        if (this._track) this._isSeeking = true;
      };
      const onEnd = () => {
        if (!this._track || !this._isSeeking) return;
        this._isSeeking = false;
        const max = parseFloat(inp.max);
        const val = parseFloat(inp.value);
        if (
          !isFinite(val) ||
          !isFinite(this.audio.duration) ||
          this.audio.duration <= 0
        )
          return;
        let ratio: number;
        if (isFinite(max) && max > 1000)
          ratio = val / 1000 / this.audio.duration;
        else if (isFinite(max) && max > 1) ratio = val / max;
        else ratio = val;
        this.seek(Math.max(0, Math.min(1, ratio)));
      };

      inp.addEventListener("mousedown", onStart, {
        capture: true,
        passive: true,
      });
      inp.addEventListener("touchstart", onStart, {
        capture: true,
        passive: true,
      });
      inp.addEventListener("mouseup", onEnd, { capture: true });
      inp.addEventListener("touchend", onEnd, { capture: true });
    };

    tryHook();
    [500, 1500, 4000].forEach((ms) => setTimeout(tryHook, ms));
  }

  // ── CSS injection ────────────────────────────────────────────────────────

  private injectStyles(): void {
    if (document.getElementById("spicecloud-styles")) return;
    const s = document.createElement("style");
    s.id = "spicecloud-styles";
    s.textContent = `
      /*
       * Controls that don't work when SoundCloud is active — hide them.
       * Shuffle / repeat: SC manages its own linear queue.
       * Lyrics / queue / connect / mini-player / fullscreen: Spotify-only features.
       * Like button: would add the paused Spotify track to Spotify favourites.
       */
      body.sc-active [data-testid="control-button-shuffle"],
      body.sc-active button[aria-label*="Shuffle" i],
      body.sc-active [data-testid="control-button-repeat"],
      body.sc-active [data-testid="lyrics-button"],
      body.sc-active [data-testid="control-button-queue"],
      body.sc-active [data-testid="devices-button"],
      body.sc-active [aria-describedby="connect-message-nudge"],
      body.sc-active button[aria-label*="Gerät verbinden" i],
      body.sc-active button[aria-label*="Connect to a device" i],
      body.sc-active button[aria-label*="Dispositivo" i],
      body.sc-active button[aria-label*="Appareil" i],
      body.sc-active [data-testid="pip-toggle-button"],
      body.sc-active [data-testid="fullscreen-mode-button"],
      body.sc-active .main-nowPlayingWidget-actionButtonWrapper,
      body.sc-active .main-trackList-enhanced { display: none !important; }

      /*
       * Source badge — fixed so it always appears above Spotify's player bar
       * regardless of which DOM element we manage to anchor into.
       */
      #spicecloud-source-badge {
        position: fixed;
        bottom: 96px;
        left: 12px;
        display: none;
        align-items: center;
        gap: 6px;
        padding: 3px 9px 3px 7px;
        border-radius: 12px;
        font-size: 10px; font-weight: 700;
        color: #fff;
        letter-spacing: 0.04em; line-height: 1.6;
        white-space: nowrap;
        z-index: 9990;
        pointer-events: none;
        box-shadow: 0 2px 6px rgba(0,0,0,0.5);
        font-family: var(--font-family, system-ui, sans-serif);
      }
      #spicecloud-source-badge { background: #ff5500; }

      /*
       * Play/Pause button visual sync.
       * Spotify stays paused while SC is active (button shows ▶ natively).
       * When body.sc-playing: hide the SVG and overlay a ⏸ using CSS mask.
       * background-color: #000 — the large center button has a white circle
       * background; we need a dark icon to be visible against it.
       */
      body.sc-playing [data-testid="control-button-playpause"] {
        position: relative !important;
      }
      body.sc-playing [data-testid="control-button-playpause"] svg {
        visibility: hidden !important;
      }
      body.sc-playing [data-testid="control-button-playpause"]::after {
        content: '';
        position: absolute;
        top: 0; left: 0; right: 0; bottom: 0;
        -webkit-mask: ${PAUSE_ICON_URL} no-repeat center / 16px 16px;
        mask: ${PAUSE_ICON_URL} no-repeat center / 16px 16px;
        background-color: #000;
        pointer-events: none;
      }

      /*
       * Track-info overlay: data-sc-title / data-sc-artist attributes + CSS ::before.
       * Never touches textContent → no React reconciliation conflict.
       */
      body.sc-active .main-trackInfo-name,
      body.sc-active [data-testid="context-item-info-title"],
      body.sc-active .now-playing__name {
        color: transparent !important;
        position: relative !important;
        white-space: nowrap !important;
        overflow: hidden !important;
      }
      body.sc-active .main-trackInfo-name *,
      body.sc-active [data-testid="context-item-info-title"] *,
      body.sc-active .now-playing__name * { color: transparent !important; }
      body.sc-active .main-trackInfo-name::before,
      body.sc-active [data-testid="context-item-info-title"]::before,
      body.sc-active .now-playing__name::before {
        content: attr(data-sc-title);
        color: var(--spice-text, #fff);
        position: absolute;
        z-index: 1;
        top: 0; left: 0; right: 0; bottom: 0;
        display: flex; align-items: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      body.sc-active .main-trackInfo-artists,
      body.sc-active [data-testid="context-item-info-subtitles"],
      body.sc-active .now-playing__artist {
        color: transparent !important;
        position: relative !important;
        white-space: nowrap !important;
        overflow: hidden !important;
      }
      body.sc-active .main-trackInfo-artists *,
      body.sc-active [data-testid="context-item-info-subtitles"] *,
      body.sc-active .now-playing__artist * { color: transparent !important; }
      body.sc-active .main-trackInfo-artists::before,
      body.sc-active [data-testid="context-item-info-subtitles"]::before,
      body.sc-active .now-playing__artist::before {
        content: attr(data-sc-artist);
        color: var(--spice-subtext, #b3b3b3);
        position: absolute;
        z-index: 1;
        top: 0; left: 0; right: 0; bottom: 0;
        display: flex; align-items: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /*
       * Time-label overlay: data-sc-time attribute + CSS ::before.
       * Never touches textContent → no React reconciliation conflict.
       */
      body.sc-active [data-testid="playback-position"],
      body.sc-active [data-testid="playback-duration"],
      body.sc-active .playback-progressbar__time-elapsed,
      body.sc-active .playback-progressbar__time-total {
        color: transparent !important;
        position: relative !important;
      }
      body.sc-active [data-testid="playback-position"]::before,
      body.sc-active [data-testid="playback-duration"]::before,
      body.sc-active .playback-progressbar__time-elapsed::before,
      body.sc-active .playback-progressbar__time-total::before {
        content: attr(data-sc-time);
        color: var(--spice-subtext, #b3b3b3);
        position: absolute;
        z-index: 1;
        top: 0; left: 0; right: 0; bottom: 0;
        display: flex; align-items: center; justify-content: center;
      }
    `;
    document.head.appendChild(s);
  }

  // ── Volume helpers ────────────────────────────────────────────────────────

  private readSpotifyVolume(): number | null {
    try {
      const inp = q<HTMLInputElement>(SEL_VOLUME);
      if (!inp) return null;
      const max = parseFloat(inp.max);
      const val = parseFloat(inp.value);
      if (!isFinite(val)) return null;
      return isFinite(max) && max > 1 ? val / max : val;
    } catch {
      return null;
    }
  }

  private syncSpotifyVolume(): void {
    const vol = this.readSpotifyVolume();
    if (vol !== null && Math.abs(this.audio.volume - vol) > 0.005) {
      this.audio.volume = vol;
    }
  }

  // ── Source badge ─────────────────────────────────────────────────────────

  private updateSourceBadge(source: "soundcloud" | null): void {
    if (this._sourceBadge && !document.contains(this._sourceBadge)) {
      this._sourceBadge = null;
    }
    if (!this._sourceBadge) {
      const el = document.createElement("div");
      el.id = "spicecloud-source-badge";
      document.body.appendChild(el);
      this._sourceBadge = el;
    }

    if (!source) {
      this._sourceBadge.style.display = "none";
      return;
    }

    if (!this._sourceBadge.dataset.ready) {
      this._sourceBadge.innerHTML =
        `<svg viewBox="0 0 24 24" fill="white" width="16" height="16" aria-hidden="true">` +
        `<path d="M23.999 14.165c-.052 1.796-1.612 3.169-3.4 3.169h-8.18a.68.68 0 0 1-.675-.683V7.862a.747.747 0 0 1 .452-.724s.75-.513 2.333-.513a5.364 5.364 0 0 1 2.763.755 5.433 5.433 0 0 1 2.57 3.54c.282-.08.574-.121.868-.12.884 0 1.73.358 2.347.992s.948 1.49.922 2.373ZM10.721 8.421c.247 2.98.427 5.697 0 8.672a.264.264 0 0 1-.53 0c-.395-2.946-.22-5.718 0-8.672a.264.264 0 0 1 .53 0ZM9.072 9.448c.285 2.659.37 4.986-.006 7.655a.277.277 0 0 1-.55 0c-.331-2.63-.256-5.02 0-7.655a.277.277 0 0 1 .556 0Zm-1.663-.257c.27 2.726.39 5.171 0 7.904a.266.266 0 0 1-.532 0c-.38-2.69-.257-5.21 0-7.904a.266.266 0 0 1 .532 0Zm-1.647.77a26.108 26.108 0 0 1-.008 7.147.272.272 0 0 1-.542 0 27.955 27.955 0 0 1 0-7.147.275.275 0 0 1 .55 0Zm-1.67 1.769c.421 1.865.228 3.5-.029 5.388a.257.257 0 0 1-.514 0c-.21-1.858-.398-3.549 0-5.389a.272.272 0 0 1 .543 0Zm-1.655-.273c.388 1.897.26 3.508-.01 5.412-.026.28-.514.283-.54 0-.244-1.878-.347-3.54-.01-5.412a.283.283 0 0 1 .56 0Zm-1.668.911c.4 1.268.257 2.292-.026 3.572a.257.257 0 0 1-.514 0c-.241-1.262-.354-2.312-.023-3.572a.283.283 0 0 1 .563 0Z"/>` +
        `</svg>SoundCloud`;
      this._sourceBadge.dataset.ready = "1";
    }

    this._sourceBadge.style.display = "flex";
  }

  // ── Progress bar ─────────────────────────────────────────────────────────

  private syncSpotifyProgress(): void {
    if (
      !this._track ||
      !isFinite(this.audio.duration) ||
      this.audio.duration <= 0
    )
      return;
    const cur = this.audio.currentTime;
    const dur = this.audio.duration;
    const fraction = cur / dur;

    // Always update time labels (text changes don't interfere with drag).
    try {
      const pe = q(SEL_POS_TEXT);
      if (pe) pe.setAttribute("data-sc-time", fmtTime(cur));
      const de = q(SEL_DUR_TEXT);
      if (de) de.setAttribute("data-sc-time", fmtTime(dur));
    } catch {}

    // Skip range-input updates while the user is dragging — otherwise the
    // thumb snaps back to SC's current position every 250 ms.
    if (this._isSeeking) return;

    try {
      const inp = q<HTMLInputElement>(SEL_PROGRESS);
      if (inp && nativeRangeSet) {
        const max = parseFloat(inp.max);
        const val =
          isFinite(max) && max > 1000
            ? String(Math.round(cur * 1000))
            : isFinite(max) && max > 1
              ? String(fraction * max)
              : String(fraction);
        if (inp.value !== val) nativeRangeSet.call(inp, val);
      }
    } catch {}
  }

  // ── Now-playing metadata ──────────────────────────────────────────────────

  private updateNowPlayingBar(track: SCTrack): void {
    try {
      const t = q(SEL_TITLE);
      if (t) t.setAttribute("data-sc-title", track.title);
      const a = q(SEL_ARTIST);
      if (a) a.setAttribute("data-sc-artist", track.user.username);
      const c = q<HTMLImageElement>(SEL_COVER);
      const art = track.artwork_url?.replace("-large", "-t500x500") ?? "";
      if (c && art) c.src = art;
    } catch {}
    document.body.classList.add("sc-active");
    this.updateSourceBadge("soundcloud");
    setTimeout(() => {
      this._tryHookSkipButtons?.();
      this.hookProgressBar();
    }, 150);
  }

  // ── Stream URL resolution ─────────────────────────────────────────────────

  private async resolveStreamUrl(track: SCTrack): Promise<string> {
    const transcodings = track.media?.transcodings ?? [];
    const progressive = transcodings.find(
      (t) => t.format?.protocol === "progressive",
    );
    if (progressive?.url) {
      try {
        const url = await resolveTranscodingUrl(progressive.url);
        if (url) return url;
      } catch (e) {
        console.warn("[SpiceCloud] Progressive transcoding resolve failed:", e);
      }
    }
    const streams = await getTrackStreams(track.id);
    const url = streams.http_mp3_128_url;
    if (url) return url;
    throw new Error("No streamable URL available for this track");
  }

  // ── Timer ─────────────────────────────────────────────────────────────────

  private startTimer(): void {
    if (this.progressTimer !== null) return;
    this.progressTimer = setInterval(() => {
      this.syncSpotifyProgress();
      this.syncSpotifyVolume();
      this.muteSpotifyAudio(true);
      this.emit();
    }, 250);
  }

  private stopTimer(): void {
    if (this.progressTimer === null) return;
    clearInterval(this.progressTimer);
    this.progressTimer = null;
  }

  private emit(): void {
    const s = this.getState();
    this.listeners.forEach((cb) => cb(s));
  }

  // ── Public state ──────────────────────────────────────────────────────────

  getState(): PlayerState {
    const raw = this.audio.duration;
    const duration =
      isFinite(raw) && raw > 0
        ? raw
        : this._track
          ? this._track.duration / 1000
          : 0;
    return {
      track: this._track,
      isPlaying: !this.audio.paused && !this.audio.ended,
      position: duration > 0 ? this.audio.currentTime / duration : 0,
      duration,
      volume: this.audio.volume,
      isLoading: this._isLoading,
      error: this._error,
    };
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ── Playback ──────────────────────────────────────────────────────────────

  async loadTrack(track: SCTrack, autoPlay = true): Promise<void> {
    const loadId = ++this._loadId;
    this._track = track;
    this._isLoading = true;
    this._error = null;
    this.startTimer();  // keep Spotify muted during stream-URL resolution
    this.emit();

    // Mute Spotify's audio immediately — belt-and-suspenders safety.
    this.muteSpotifyAudio(true);

    // Pause Spotify so its track position doesn't advance during SC playback.
    // The _isLoading guard ensures the resulting onplaypause echo is ignored.
    try {
      if (Spicetify.Player.data?.item && Spicetify.Player.isPlaying()) {
        Spicetify.Player.pause();
      }
    } catch {}

    try {
      const url = await this.resolveStreamUrl(track);
      if (loadId !== this._loadId) return;

      this.audio.src = url;
      this.audio.load();
      // Read volume from Spotify's DOM slider — only reliable source.
      // Default 0.5 so first audio frame never blasts at 100%.
      this.audio.volume = this.readSpotifyVolume() ?? 0.5;

      if (autoPlay) {
        try {
          await this.audio.play();
        } catch (e) {
          console.warn("[SpiceCloud] Autoplay blocked:", e);
        }
      }

      this.updateNowPlayingBar(track);
      // Prime time labels immediately so the overlay never shows "0:00/0:00".
      try {
        const pe = q(SEL_POS_TEXT);
        if (pe) pe.setAttribute("data-sc-time", "0:00");
        const de = q(SEL_DUR_TEXT);
        if (de) de.setAttribute("data-sc-time", fmtTime(track.duration / 1000));
      } catch {}
    } catch (err) {
      if (loadId !== this._loadId) return;
      this._error = err instanceof Error ? err.message : "Failed to load track";
    } finally {
      if (loadId === this._loadId) {
        this._isLoading = false;
        this.emit();
      }
    }
  }

  setQueue(tracks: SCTrack[], startIndex = 0): void {
    this.queue = tracks;
    this.queueIndex = startIndex;
  }

  // play() and pause() only touch this.audio — NEVER Spicetify.Player.
  // Spicetify state is exclusively managed by the onplaypause toggle handler.
  // Mixing both causes the handler to receive an echo and toggle in the wrong
  // direction.

  async play(): Promise<void> {
    try {
      await this.audio.play();
    } catch (e) {
      console.warn("[SpiceCloud] play() blocked:", e);
    }
  }

  pause(): void {
    this.audio.pause();
  }

  toggle(): void {
    if (this.audio.paused) void this.play();
    else this.pause();
  }

  seek(ratio: number): void {
    const r = Math.max(0, Math.min(1, ratio));
    if (isFinite(this.audio.duration) && this.audio.duration > 0) {
      this.audio.currentTime = this.audio.duration * r;
    }
  }

  setVolume(vol: number): void {
    this.audio.volume = Math.max(0, Math.min(1, vol));
  }

  async next(): Promise<void> {
    if (this.queueIndex < this.queue.length - 1) {
      this.queueIndex++;
      await this.loadTrack(this.queue[this.queueIndex]);
    }
  }

  async prev(): Promise<void> {
    if (this.audio.currentTime > 3 || this.queueIndex <= 0) {
      this.audio.currentTime = 0;
      return;
    }
    this.queueIndex--;
    await this.loadTrack(this.queue[this.queueIndex]);
  }

  destroy(): void {
    this.stopTimer();
    this.audio.pause();
    this.audio.src = "";
    this.audio.remove();
    this.muteSpotifyAudio(false);
    this._sourceBadge?.remove();
    this._sourceBadge = null;
    document.body.classList.remove("sc-active", "sc-playing");
    this.listeners.clear();
  }
}

export const player = new SoundCloudPlayer();
