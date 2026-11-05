import { useEffect, useRef, useState } from "react";
import { Timer as TimerIcon, Volume2, VolumeX } from "lucide-react";
import { useCountdown } from "@/hooks/useGameRoom";
import { cn } from "@/lib/utils";

const COUNTDOWN_SOUND_KEY = "drawoff:countdown-sound";
let audioContext: AudioContext | null = null;

function soundPreference(): boolean {
  try {
    return window.localStorage.getItem(COUNTDOWN_SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}

function saveSoundPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(COUNTDOWN_SOUND_KEY, enabled ? "on" : "off");
  } catch {
    // Storage can be unavailable in private browsing; the in-memory choice still works.
  }
}

function playCountdownTick(seconds: number): void {
  const WindowAudioContext = window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!WindowAudioContext) return;

  audioContext ??= new WindowAudioContext();
  const play = () => {
    const startAt = audioContext!.currentTime;
    const oscillator = audioContext!.createOscillator();
    const gain = audioContext!.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(seconds <= 3 ? 880 : 660, startAt);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.12, startAt + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.09);
    oscillator.connect(gain);
    gain.connect(audioContext!.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + 0.1);
  };

  if (audioContext.state === "suspended") {
    void audioContext.resume().then(play).catch(() => undefined);
  } else {
    play();
  }
}

export function Timer({
  deadline,
  clockOffset,
  frozen,
  warnAt = 10,
  countdownSound = false,
  className,
}: {
  deadline: number | null;
  clockOffset: number;
  frozen?: boolean;
  warnAt?: number;
  countdownSound?: boolean;
  className?: string;
}) {
  const seconds = useCountdown(deadline, clockOffset, frozen);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [soundPreferenceLoaded, setSoundPreferenceLoaded] = useState(false);
  const playedSecond = useRef<number | null>(null);

  useEffect(() => {
    setSoundEnabled(soundPreference());
    setSoundPreferenceLoaded(true);
  }, []);

  useEffect(() => {
    if (
      !countdownSound ||
      !soundEnabled ||
      !soundPreferenceLoaded ||
      frozen ||
      seconds === null ||
      seconds < 1 ||
      seconds > 10 ||
      playedSecond.current === seconds
    ) {
      return;
    }
    playedSecond.current = seconds;
    playCountdownTick(seconds);
  }, [countdownSound, frozen, seconds, soundEnabled, soundPreferenceLoaded]);

  if (seconds === null) return null;
  const warn = seconds <= warnAt;
  return (
    <div className={cn("inline-flex items-center gap-1.5", className)}>
      <div
        role="timer"
        aria-live="off"
        className={cn(
          "sticker-sm inline-flex items-center gap-1.5 px-3 py-1 font-display text-lg font-bold tabular-nums",
          warn ? "bg-primary text-primary-foreground animate-wobble" : "bg-card",
        )}
      >
        <TimerIcon className="size-4" />
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
      </div>
      {countdownSound && (
        <button
          type="button"
          className="sticker-sm inline-flex size-8 cursor-pointer items-center justify-center bg-card hover:bg-muted focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ink"
          aria-label={soundEnabled ? "Mute countdown sound" : "Enable countdown sound"}
          aria-pressed={soundEnabled}
          onClick={() => {
            const enabled = !soundEnabled;
            setSoundEnabled(enabled);
            saveSoundPreference(enabled);
            if (enabled && seconds >= 1 && seconds <= 10) {
              playedSecond.current = seconds;
              playCountdownTick(seconds);
            }
          }}
        >
          {soundEnabled ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
        </button>
      )}
    </div>
  );
}
