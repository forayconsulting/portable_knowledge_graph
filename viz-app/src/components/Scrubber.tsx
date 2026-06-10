import type { VizController } from "../controller";

const SPEEDS = [0.5, 1, 2, 4];

/**
 * Playback controls: scrub through the graph's growth history. "Timeline"
 * spacing is proportional to real time; "Even" reveals one element at a
 * time, which reads better for bursty ingest histories.
 */
export function Scrubber({ controller }: { controller: VizController }) {
	const counts = controller.playbackCounts.value;

	return (
		<footer class="scrubber">
			<button type="button" class="btn" onClick={() => controller.togglePlay()}>
				{controller.playing.value ? "⏸" : "▶"}
			</button>

			<input
				type="range"
				min="0"
				max="1000"
				value={Math.round(controller.progress.value * 1000)}
				onInput={(e) => {
					controller.playing.value = false;
					controller.seek(Number((e.target as HTMLInputElement).value) / 1000);
				}}
			/>

			<span class="scrub-label">
				{controller.playbackLabel.value}
				<span class="muted">
					{" "}
					· {counts.visible.toLocaleString()} of {counts.total.toLocaleString()}
				</span>
			</span>

			<div class="speed-group">
				{SPEEDS.map((s) => (
					<button
						key={s}
						type="button"
						class={`btn btn-sm ${controller.speed.value === s ? "btn-active" : ""}`}
						onClick={() => controller.setSpeed(s)}
					>
						{s}×
					</button>
				))}
			</div>

			<button
				type="button"
				class={`btn btn-sm ${controller.mode.value === "even" ? "btn-active" : ""}`}
				title="Even spacing: reveal elements one by one instead of by real timestamps"
				onClick={() =>
					controller.setMode(controller.mode.value === "even" ? "real" : "even")
				}
			>
				Even
			</button>

			<button
				type="button"
				class="btn btn-sm"
				onClick={() => controller.exitPlayback()}
			>
				Done
			</button>
		</footer>
	);
}
