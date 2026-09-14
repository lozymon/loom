import { createSignal, onCleanup } from "solid-js";

function format(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Time left until an approval is denied automatically. */
export function Countdown(props: { until: number }) {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));
  const left = () => props.until - now();
  return (
    <span class="countdown" classList={{ urgent: left() < 60_000 }} title="Denied automatically when this runs out">
      denies in {format(left())}
    </span>
  );
}
