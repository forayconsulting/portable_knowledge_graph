import { useSignal } from "@preact/signals";
import type { VizController } from "../controller";
import type { Meta } from "../types";

export function TopBar({
	controller,
	meta,
}: {
	controller: VizController;
	meta: Meta;
}) {
	const query = useSignal("");
	const showAbout = useSignal(false);
	const results = query.value ? controller.searchNodes(query.value) : [];
	const edgeTotal = Object.values(meta.edges_by_type).reduce(
		(a, b) => a + b,
		0,
	);

	return (
		<header class="topbar">
			<div class="topbar-title">
				<h1>{meta.display_name}</h1>
				<span class="muted">
					{meta.node_count.toLocaleString()} nodes ·{" "}
					{edgeTotal.toLocaleString()} relationships
				</span>
			</div>

			<div class="topbar-search">
				<input
					type="search"
					placeholder="Find a node…"
					value={query.value}
					onInput={(e) => {
						query.value = (e.target as HTMLInputElement).value;
					}}
				/>
				{results.length > 0 && (
					<ul class="search-results">
						{results.map((r) => (
							<li key={r.id}>
								<button
									type="button"
									onClick={() => {
										controller.focusNode(r.id);
										query.value = "";
									}}
								>
									<span
										class="dot"
										style={{
											background: controller.colorForType(r.node.entity_type),
										}}
									/>
									{r.node.name}
									<span class="muted"> {r.node.entity_type}</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</div>

			<div class="topbar-actions">
				<button
					type="button"
					class="btn"
					title="Replay how this graph was built, in fast-forward"
					onClick={() => controller.enterPlayback()}
				>
					▶ Replay growth
				</button>
				<button
					type="button"
					class={`btn ${controller.layoutRunning.value ? "btn-active" : ""}`}
					title="Toggle force-directed layout"
					onClick={() => controller.toggleLayout()}
				>
					Layout
				</button>
				<button
					type="button"
					class="btn btn-icon"
					title="About this viewer"
					onClick={() => {
						showAbout.value = !showAbout.value;
					}}
				>
					ⓘ
				</button>
			</div>

			{showAbout.value && (
				<div class="about-pop">
					<h3>A lens, not a gatekeeper</h3>
					<p>
						This viewer is read-only. It shows the knowledge graph as it is,
						highlights what an AI session is examining as it happens, and lets
						you replay how the graph grew. Interpretation stays with you.
					</p>
					<p class="muted">
						The data remains fully yours: query it directly over MCP at{" "}
						<code>/mcp/{meta.graph_id}</code> or with Cypher against the Neo4j
						instance.
					</p>
					<p class="muted">
						Your access level: <strong>{meta.role}</strong>
					</p>
				</div>
			)}
		</header>
	);
}
