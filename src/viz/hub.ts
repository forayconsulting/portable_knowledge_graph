import { DurableObject } from "cloudflare:workers";
import type { VizEvent } from "./events";

const RING_BUFFER_SIZE = 100;
const RING_KEY = "ring";
const SEQ_KEY = "seq";

interface SequencedEvent extends VizEvent {
	seq: number;
}

/**
 * Per-graph fan-out hub for live viz events. One instance per graph
 * (idFromName(graphId)). Viz clients connect over hibernatable WebSockets;
 * MCP tool wrappers call publish() via RPC. Events are ephemeral apart from
 * a small ring buffer replayed to newly connected viewers.
 */
export class VizHub extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected WebSocket upgrade", { status: 426 });
		}

		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);

		const ring = (await this.ctx.storage.get<SequencedEvent[]>(RING_KEY)) ?? [];
		pair[1].send(JSON.stringify({ type: "backlog", events: ring }));

		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async publish(event: VizEvent): Promise<void> {
		const seq = ((await this.ctx.storage.get<number>(SEQ_KEY)) ?? 0) + 1;
		const sequenced: SequencedEvent = { ...event, seq };

		const ring = (await this.ctx.storage.get<SequencedEvent[]>(RING_KEY)) ?? [];
		ring.push(sequenced);
		while (ring.length > RING_BUFFER_SIZE) ring.shift();
		await this.ctx.storage.put(SEQ_KEY, seq);
		await this.ctx.storage.put(RING_KEY, ring);

		const message = JSON.stringify({ type: "event", event: sequenced });
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(message);
			} catch {
				// socket already closing — hibernation API will reap it
			}
		}
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		// Clients send "ping" keepalives; anything else is ignored (read-only hub).
		if (message === "ping") {
			try {
				ws.send('{"type":"pong"}');
			} catch {
				// ignore
			}
		}
	}

	async webSocketClose(ws: WebSocket) {
		try {
			ws.close();
		} catch {
			// already closed
		}
	}
}
