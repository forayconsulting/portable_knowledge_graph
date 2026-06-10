import type { VizController } from "./controller";
import type { LiveEvent } from "./types";

const PING_INTERVAL_MS = 50000;
const MAX_BACKOFF_MS = 30000;

interface HubMessage {
	type: "backlog" | "event" | "pong";
	events?: LiveEvent[];
	event?: LiveEvent;
}

/**
 * Maintains the WebSocket to the per-graph VizHub. The backlog received on
 * connect populates the activity feed without pulsing (it's history); live
 * events both append to the feed and pulse the touched subgraph.
 */
export class LiveClient {
	private ws: WebSocket | null = null;
	private backoff = 1000;
	private pingTimer = 0;
	private closed = false;
	private seenIds = new Set<string>();

	constructor(
		private graphId: string,
		private controller: VizController,
	) {}

	connect(): void {
		this.closed = false;
		const proto = location.protocol === "https:" ? "wss:" : "ws:";
		this.controller.wsStatus.value = "connecting";
		const ws = new WebSocket(
			`${proto}//${location.host}/viz/ws/${this.graphId}`,
		);
		this.ws = ws;

		ws.onopen = () => {
			this.backoff = 1000;
			this.controller.wsStatus.value = "live";
			this.pingTimer = window.setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) ws.send("ping");
			}, PING_INTERVAL_MS);
		};

		ws.onmessage = (msg) => {
			let parsed: HubMessage;
			try {
				parsed = JSON.parse(String(msg.data)) as HubMessage;
			} catch {
				return;
			}
			if (parsed.type === "backlog" && parsed.events) {
				const fresh = parsed.events.filter((e) => !this.seenIds.has(e.id));
				for (const e of fresh) this.seenIds.add(e.id);
				this.controller.ingestEvents(fresh, false);
			} else if (parsed.type === "event" && parsed.event) {
				if (this.seenIds.has(parsed.event.id)) return;
				this.seenIds.add(parsed.event.id);
				this.controller.ingestEvents([parsed.event], true);
			}
		};

		ws.onclose = () => {
			window.clearInterval(this.pingTimer);
			this.controller.wsStatus.value = "offline";
			if (this.closed) return;
			setTimeout(() => this.connect(), this.backoff);
			this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
		};

		ws.onerror = () => {
			ws.close();
		};
	}

	close(): void {
		this.closed = true;
		window.clearInterval(this.pingTimer);
		this.ws?.close();
	}
}
