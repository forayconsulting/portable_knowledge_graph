import { useSignal } from "@preact/signals";
import type { VizController } from "../controller";
import type { LiveEvent } from "../types";

function EventRow({
	event,
	controller,
}: {
	event: LiveEvent;
	controller: VizController;
}) {
	const open = useSignal(false);
	const touched = event.node_ids.length + event.edges.length;
	const time = new Date(event.ts).toLocaleTimeString();

	return (
		<div class={`event-row ${event.is_error ? "event-error" : ""}`}>
			<button
				type="button"
				class="event-summary"
				onClick={() => {
					open.value = !open.value;
					controller.applyHighlights(event);
				}}
				title="Click to expand and re-highlight what this call touched"
			>
				<span class="event-time muted">{time}</span>
				<span class="event-tool">
					{event.tool}
					{event.action ? `:${event.action}` : ""}
				</span>
				<span class="muted event-meta">
					{event.email} · {touched ? `${touched} touched` : "no graph elements"}{" "}
					· {event.duration_ms}ms
					{event.is_error ? " · error" : ""}
				</span>
			</button>
			{open.value && (
				<div class="event-detail">
					{event.args_preview && (
						<div>
							<span class="detail-label">arguments</span>
							<pre>{event.args_preview}</pre>
						</div>
					)}
					{event.cypher.length > 0 && (
						<div>
							<span class="detail-label">
								cypher — exactly what ran against the database
							</span>
							{event.cypher.map((c) => (
								<pre key={c.statement}>
									{c.statement}
									{c.params ? `\n// params: ${c.params}` : ""}
								</pre>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/**
 * Collapsible live activity drawer. Collapsed: a slim status strip with the
 * latest call. Expanded: every recent MCP tool call, each opening to the
 * exact Cypher it ran (legibility — see what the tool is doing and why).
 */
export function ActivityFeed({ controller }: { controller: VizController }) {
	const open = useSignal(false);
	const events = controller.events.value;
	const latest = events[events.length - 1];
	const status = controller.wsStatus.value;

	return (
		<footer class={`feed ${open.value ? "feed-open" : ""}`}>
			<button
				type="button"
				class="feed-bar"
				onClick={() => {
					open.value = !open.value;
				}}
			>
				<span
					class={`status-dot status-${status}`}
					title={`Live feed: ${status}`}
				/>
				<span class="feed-title">Activity</span>
				{latest ? (
					<span class="muted feed-latest">
						{latest.tool}
						{latest.action ? `:${latest.action}` : ""} ·{" "}
						{new Date(latest.ts).toLocaleTimeString()}
					</span>
				) : (
					<span class="muted feed-latest">
						{status === "live"
							? "Watching — MCP tool calls will appear here as they happen"
							: "Connecting to live feed…"}
					</span>
				)}
				<span class="feed-toggle">{open.value ? "▾" : "▴"}</span>
			</button>
			{open.value && (
				<div class="feed-body">
					{events.length === 0 ? (
						<p class="muted feed-empty">
							No recent activity. When Claude (or any MCP client) works this
							graph, each tool call appears here with the nodes it touched and
							the Cypher it ran.
						</p>
					) : (
						[...events]
							.reverse()
							.map((e) => (
								<EventRow key={e.id} event={e} controller={controller} />
							))
					)}
				</div>
			)}
		</footer>
	);
}
