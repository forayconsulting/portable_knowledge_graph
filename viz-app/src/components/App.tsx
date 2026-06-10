import { useSignal } from "@preact/signals";
import { useEffect, useMemo, useRef } from "preact/hooks";
import { fetchMeta, fetchSnapshot, graphIdFromUrl } from "../api";
import { VizController } from "../controller";
import { LiveClient } from "../live";
import type { Meta } from "../types";
import { ActivityFeed } from "./ActivityFeed";
import { ChipsBar } from "./ChipsBar";
import { NodePanel } from "./NodePanel";
import { Scrubber } from "./Scrubber";
import { TopBar } from "./TopBar";

export function App() {
	const graphId = useMemo(graphIdFromUrl, []);
	const controller = useMemo(() => new VizController(), []);
	const meta = useSignal<Meta | null>(null);
	const error = useSignal<string | null>(null);
	const truncated = useSignal(false);
	const canvasRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let live: LiveClient | null = null;
		(async () => {
			try {
				const [m, snapshot] = await Promise.all([
					fetchMeta(graphId),
					fetchSnapshot(graphId),
				]);
				meta.value = m;
				document.title = `${m.display_name} · Knowledge Graph`;
				truncated.value = snapshot.has_more;
				controller.load(m, snapshot);
				if (canvasRef.current) controller.init(canvasRef.current);
				live = new LiveClient(graphId, controller);
				live.connect();
			} catch (e) {
				error.value = e instanceof Error ? e.message : String(e);
			}
		})();
		return () => {
			live?.close();
			controller.destroy();
		};
	}, [graphId]);

	if (error.value) {
		return (
			<div class="center-state">
				<div class="error-card">
					<h2>Can't open this graph</h2>
					<p>{error.value}</p>
					<p class="muted">
						Graph: <code>{graphId}</code>
					</p>
				</div>
			</div>
		);
	}

	return (
		<div class="app">
			<div class="canvas" ref={canvasRef} />
			{!controller.ready.value && (
				<div class="center-state">
					<div class="spinner" />
					<p class="muted">Loading graph…</p>
				</div>
			)}
			{meta.value && (
				<>
					<TopBar controller={controller} meta={meta.value} />
					<ChipsBar controller={controller} meta={meta.value} />
					{truncated.value && (
						<div class="truncation-notice">
							Showing the first nodes by creation time — the full graph is
							larger. Narrow by namespace, or query it directly via MCP.
						</div>
					)}
					<NodePanel controller={controller} graphId={graphId} />
					{controller.playbackActive.value ? (
						<Scrubber controller={controller} />
					) : (
						<ActivityFeed controller={controller} />
					)}
				</>
			)}
		</div>
	);
}
