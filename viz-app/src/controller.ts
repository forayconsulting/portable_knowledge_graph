import { signal } from "@preact/signals";
import Graph from "graphology";
import { circular } from "graphology-layout";
import forceAtlas2 from "graphology-layout-forceatlas2";
import FA2LayoutWorker from "graphology-layout-forceatlas2/worker";
import Sigma from "sigma";
import type { LiveEvent, Meta, Snapshot, VizNode } from "./types";

const PULSE_MS = 4000;
const ACCENT = "#ff9e64";
const SELECT_COLOR = "#c0caf5";
const EDGE_COLOR = "#2f3349";
const EDGE_HIGHLIGHT = "#ff9e64";
const DIM_COLOR = "#23263a";

const PALETTE = [
	"#7aa2f7",
	"#9ece6a",
	"#e0af68",
	"#bb9af7",
	"#7dcfff",
	"#f7768e",
	"#73daca",
	"#ff9e64",
	"#b4f9f8",
	"#c0caf5",
	"#41a6b5",
	"#d18616",
];

export type PlaybackMode = "real" | "even";

interface TimedElement {
	kind: "node" | "edge";
	key: string;
	time: number;
}

export class VizController {
	graph = new Graph({ multi: true, type: "directed" });
	sigma: Sigma | null = null;
	meta: Meta | null = null;

	// UI state
	readonly ready = signal(false);
	readonly selectedId = signal<string | null>(null);
	readonly hiddenNamespaces = signal<ReadonlySet<string>>(new Set());
	readonly hiddenTypes = signal<ReadonlySet<string>>(new Set());
	readonly layoutRunning = signal(false);
	readonly events = signal<LiveEvent[]>([]);
	readonly wsStatus = signal<"connecting" | "live" | "offline">("connecting");

	// Playback state
	readonly playbackActive = signal(false);
	readonly playing = signal(false);
	readonly progress = signal(0); // 0..1
	readonly speed = signal(1);
	readonly mode = signal<PlaybackMode>("real");
	readonly playbackLabel = signal("");
	readonly playbackCounts = signal<{ visible: number; total: number }>({
		visible: 0,
		total: 0,
	});

	private typeColors = new Map<string, string>();
	private highlights = new Map<string, number>(); // node key -> expiry
	private edgeHighlights = new Map<string, number>(); // edge key -> expiry
	private hoveredNode: string | null = null;
	private hoveredNeighbors: Set<string> | null = null;
	private timeline: TimedElement[] = [];
	private timeRange: [number, number] = [0, 0];
	private appearIndex = new Map<string, number>(); // element key -> rank
	private appearTime = new Map<string, number>(); // element key -> epoch ms
	private fa2Worker: InstanceType<typeof FA2LayoutWorker> | null = null;
	private rafId = 0;
	private lastTick = 0;
	private playbackDurationMs = 30000;

	colorForType(type: string | null): string {
		const key = type ?? "(untyped)";
		let color = this.typeColors.get(key);
		if (!color) {
			color = PALETTE[this.typeColors.size % PALETTE.length];
			this.typeColors.set(key, color);
		}
		return color;
	}

	load(meta: Meta, snapshot: Snapshot): void {
		this.meta = meta;
		// Assign palette colors to the most common types first
		for (const type of Object.keys(meta.nodes_by_type)) {
			this.colorForType(type);
		}

		for (const n of snapshot.nodes) {
			if (this.graph.hasNode(n.id)) continue;
			this.graph.addNode(n.id, {
				label: n.name,
				size: Math.min(3 + Math.log2(1 + n.degree) * 1.6, 14),
				color: this.colorForType(n.entity_type),
				node: n,
			});
		}
		for (const e of snapshot.edges) {
			if (!this.graph.hasNode(e.from) || !this.graph.hasNode(e.to)) continue;
			const key = `${e.from}|${e.rel_type}|${e.to}`;
			if (this.graph.hasEdge(key)) continue;
			this.graph.addEdgeWithKey(key, e.from, e.to, {
				label: e.rel_type,
				size: 1,
				color: EDGE_COLOR,
				edge: e,
			});
		}

		this.buildTimeline(snapshot);

		// Layout: deterministic circular seed, then ForceAtlas2
		circular.assign(this.graph);
		const settings = forceAtlas2.inferSettings(this.graph);
		if (this.graph.order <= 600) {
			forceAtlas2.assign(this.graph, { iterations: 300, settings });
		} else {
			forceAtlas2.assign(this.graph, { iterations: 50, settings });
			this.fa2Worker = new FA2LayoutWorker(this.graph, { settings });
			this.startLayout();
			setTimeout(() => this.stopLayout(), 4000);
		}
	}

	private buildTimeline(snapshot: Snapshot): void {
		const elements: TimedElement[] = [];
		for (const n of snapshot.nodes) {
			elements.push({
				kind: "node",
				key: n.id,
				time: Date.parse(n.created_at) || 0,
			});
		}
		for (const e of snapshot.edges) {
			const key = `${e.from}|${e.rel_type}|${e.to}`;
			if (!this.graph.hasEdge(key)) continue;
			// An edge can never appear before either endpoint
			const endpoints = Math.max(
				Date.parse(
					(this.graph.getNodeAttribute(e.from, "node") as VizNode).created_at,
				) || 0,
				Date.parse(
					(this.graph.getNodeAttribute(e.to, "node") as VizNode).created_at,
				) || 0,
			);
			elements.push({
				kind: "edge",
				key,
				time: Math.max(Date.parse(e.created_at) || 0, endpoints),
			});
		}
		elements.sort((a, b) => a.time - b.time || (a.kind === "node" ? -1 : 1));
		this.timeline = elements;
		elements.forEach((el, i) => {
			this.appearIndex.set(el.key, i);
			this.appearTime.set(el.key, el.time);
		});
		if (elements.length) {
			this.timeRange = [elements[0].time, elements[elements.length - 1].time];
		}
	}

	init(container: HTMLElement): void {
		this.sigma = new Sigma(this.graph, container, {
			renderLabels: true,
			labelRenderedSizeThreshold: 7,
			labelColor: { color: "#a9b1d6" },
			labelFont: "ui-sans-serif, system-ui, sans-serif",
			labelSize: 12,
			defaultEdgeType: "arrow",
			zIndex: true,
			enableEdgeEvents: false,
			nodeReducer: (key, data) => this.nodeReducer(key, data),
			edgeReducer: (key, data) => this.edgeReducer(key, data),
		});

		this.sigma.on("clickNode", ({ node }) => {
			this.selectedId.value = this.selectedId.value === node ? null : node;
			this.refresh();
		});
		this.sigma.on("clickStage", () => {
			this.selectedId.value = null;
			this.refresh();
		});
		this.sigma.on("enterNode", ({ node }) => {
			this.hoveredNode = node;
			this.hoveredNeighbors = new Set(this.graph.neighbors(node));
			this.refresh();
		});
		this.sigma.on("leaveNode", () => {
			this.hoveredNode = null;
			this.hoveredNeighbors = null;
			this.refresh();
		});

		this.ready.value = true;
	}

	// biome-ignore lint/suspicious/noExplicitAny: sigma's reducer data types
	private nodeReducer(key: string, data: any) {
		const res: Record<string, unknown> = { ...data };
		const n = data.node as VizNode;

		if (this.isNodeFiltered(n)) {
			res.hidden = true;
			return res;
		}
		if (this.playbackActive.value && !this.isVisibleAtCursor(key)) {
			res.hidden = true;
			return res;
		}

		const pulse = this.pulseIntensity(this.highlights.get(key));
		if (pulse > 0) {
			res.color = ACCENT;
			res.size = (data.size as number) + 4 * pulse;
			res.zIndex = 10;
			res.forceLabel = true;
		}
		if (key === this.selectedId.value) {
			res.highlighted = true;
			res.zIndex = 20;
		}
		if (
			this.hoveredNode &&
			key !== this.hoveredNode &&
			!this.hoveredNeighbors?.has(key) &&
			pulse === 0 &&
			key !== this.selectedId.value
		) {
			res.color = DIM_COLOR;
			res.label = "";
		}
		return res;
	}

	// biome-ignore lint/suspicious/noExplicitAny: sigma's reducer data types
	private edgeReducer(key: string, data: any) {
		const res: Record<string, unknown> = { ...data };
		if (this.playbackActive.value && !this.isVisibleAtCursor(key)) {
			res.hidden = true;
			return res;
		}
		const pulse = this.pulseIntensity(this.edgeHighlights.get(key));
		if (pulse > 0) {
			res.color = EDGE_HIGHLIGHT;
			res.size = 1 + 2.5 * pulse;
			res.zIndex = 10;
		} else if (this.hoveredNode) {
			const [s, t] = this.graph.extremities(key);
			if (s !== this.hoveredNode && t !== this.hoveredNode) {
				res.color = DIM_COLOR;
			}
		}
		if (this.selectedId.value) {
			const [s, t] = this.graph.extremities(key);
			if (s === this.selectedId.value || t === this.selectedId.value) {
				res.color = SELECT_COLOR;
				res.size = 1.5;
				res.zIndex = 15;
			}
		}
		return res;
	}

	private isNodeFiltered(n: VizNode): boolean {
		const ns = n.namespace ?? "(global)";
		const type = n.entity_type ?? "(untyped)";
		return (
			this.hiddenNamespaces.value.has(ns) || this.hiddenTypes.value.has(type)
		);
	}

	private pulseIntensity(expiry: number | undefined): number {
		if (!expiry) return 0;
		const remaining = expiry - performance.now();
		if (remaining <= 0) return 0;
		return remaining / PULSE_MS;
	}

	toggleNamespace(ns: string): void {
		const next = new Set(this.hiddenNamespaces.value);
		next.has(ns) ? next.delete(ns) : next.add(ns);
		this.hiddenNamespaces.value = next;
		this.refresh();
	}

	toggleType(type: string): void {
		const next = new Set(this.hiddenTypes.value);
		next.has(type) ? next.delete(type) : next.add(type);
		this.hiddenTypes.value = next;
		this.refresh();
	}

	searchNodes(query: string, limit = 8): Array<{ id: string; node: VizNode }> {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		const results: Array<{ id: string; node: VizNode }> = [];
		this.graph.forEachNode((id, attrs) => {
			if (results.length >= limit) return;
			const n = attrs.node as VizNode;
			if (n.name.toLowerCase().includes(q)) results.push({ id, node: n });
		});
		return results;
	}

	focusNode(id: string): void {
		if (!this.sigma || !this.graph.hasNode(id)) return;
		this.selectedId.value = id;
		const pos = this.sigma.getNodeDisplayData(id);
		if (pos) {
			this.sigma
				.getCamera()
				.animate({ x: pos.x, y: pos.y, ratio: 0.25 }, { duration: 500 });
		}
		this.refresh();
	}

	// ---- Live events ----

	ingestEvents(incoming: LiveEvent[], pulse: boolean): void {
		if (!incoming.length) return;
		this.events.value = [...this.events.value, ...incoming].slice(-200);
		if (pulse) {
			for (const event of incoming) this.applyHighlights(event);
		}
	}

	applyHighlights(event: LiveEvent): void {
		const until = performance.now() + PULSE_MS;
		let touched = false;
		for (const id of event.node_ids) {
			if (this.graph.hasNode(id)) {
				this.highlights.set(id, until);
				touched = true;
			}
		}
		for (const e of event.edges) {
			if (!this.graph.hasNode(e.from) || !this.graph.hasNode(e.to)) continue;
			for (const key of [
				...this.graph.edges(e.from, e.to),
				...this.graph.edges(e.to, e.from),
			]) {
				this.edgeHighlights.set(key, until);
				touched = true;
			}
		}
		if (touched) this.ensureTicking();
	}

	// ---- Playback ----

	enterPlayback(): void {
		this.playbackActive.value = true;
		this.progress.value = 0;
		this.playing.value = true;
		this.updatePlaybackLabel();
		this.ensureTicking();
	}

	exitPlayback(): void {
		this.playbackActive.value = false;
		this.playing.value = false;
		this.refresh();
	}

	togglePlay(): void {
		if (this.progress.value >= 1) this.progress.value = 0;
		this.playing.value = !this.playing.value;
		if (this.playing.value) this.ensureTicking();
	}

	seek(p: number): void {
		this.progress.value = Math.max(0, Math.min(1, p));
		this.updatePlaybackLabel();
		this.refresh();
	}

	setSpeed(s: number): void {
		this.speed.value = s;
	}

	setMode(m: PlaybackMode): void {
		this.mode.value = m;
		this.updatePlaybackLabel();
		this.refresh();
	}

	private isVisibleAtCursor(key: string): boolean {
		const p = this.progress.value;
		if (p >= 1) return true;
		if (this.mode.value === "even") {
			const idx = this.appearIndex.get(key);
			return idx !== undefined && idx <= p * (this.timeline.length - 1);
		}
		const time = this.appearTime.get(key);
		const cutoff =
			this.timeRange[0] + p * (this.timeRange[1] - this.timeRange[0]);
		return time !== undefined && time <= cutoff;
	}

	private updatePlaybackLabel(): void {
		if (!this.timeline.length) return;
		const p = this.progress.value;
		let cutoffTime: number;
		let visible: number;
		if (this.mode.value === "even") {
			const idx = Math.floor(p * (this.timeline.length - 1));
			cutoffTime = this.timeline[idx]?.time ?? this.timeRange[0];
			visible = idx + 1;
		} else {
			cutoffTime =
				this.timeRange[0] + p * (this.timeRange[1] - this.timeRange[0]);
			visible = this.timeline.filter((el) => el.time <= cutoffTime).length;
		}
		this.playbackLabel.value = new Date(cutoffTime).toLocaleString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
		this.playbackCounts.value = { visible, total: this.timeline.length };
	}

	// ---- Layout ----

	startLayout(): void {
		if (!this.fa2Worker) {
			const settings = forceAtlas2.inferSettings(this.graph);
			this.fa2Worker = new FA2LayoutWorker(this.graph, { settings });
		}
		if (!this.fa2Worker.isRunning()) this.fa2Worker.start();
		this.layoutRunning.value = true;
	}

	stopLayout(): void {
		this.fa2Worker?.stop();
		this.layoutRunning.value = false;
	}

	toggleLayout(): void {
		this.layoutRunning.value ? this.stopLayout() : this.startLayout();
	}

	// ---- Animation loop ----

	private ensureTicking(): void {
		if (this.rafId) return;
		this.lastTick = performance.now();
		const tick = (now: number) => {
			const dt = now - this.lastTick;
			this.lastTick = now;

			if (this.playbackActive.value && this.playing.value) {
				const delta = (dt * this.speed.value) / this.playbackDurationMs;
				const next = Math.min(1, this.progress.value + delta);
				this.progress.value = next;
				this.updatePlaybackLabel();
				if (next >= 1) this.playing.value = false;
			}

			for (const [k, until] of this.highlights) {
				if (until <= now) this.highlights.delete(k);
			}
			for (const [k, until] of this.edgeHighlights) {
				if (until <= now) this.edgeHighlights.delete(k);
			}

			this.refresh();

			const active =
				this.highlights.size > 0 ||
				this.edgeHighlights.size > 0 ||
				(this.playbackActive.value && this.playing.value);
			if (active) {
				this.rafId = requestAnimationFrame(tick);
			} else {
				this.rafId = 0;
			}
		};
		this.rafId = requestAnimationFrame(tick);
	}

	refresh(): void {
		this.sigma?.refresh({ skipIndexation: true });
	}

	destroy(): void {
		if (this.rafId) cancelAnimationFrame(this.rafId);
		this.fa2Worker?.kill();
		this.sigma?.kill();
	}
}
