import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { fetchNodeDetail } from "../api";
import type { VizController } from "../controller";
import type { NodeDetail, VizNode } from "../types";

const EPISTEMIC_BADGES: Record<string, string> = {
	verified: "badge-green",
	probable: "badge-blue",
	speculative: "badge-yellow",
	contested: "badge-orange",
	deprecated: "badge-red",
};

function PropertyTable({ data }: { data: Record<string, unknown> }) {
	const entries = Object.entries(data).filter(
		([, v]) => v !== null && v !== undefined && v !== "",
	);
	if (!entries.length) return <p class="muted">No properties.</p>;
	return (
		<table class="prop-table">
			<tbody>
				{entries.map(([k, v]) => (
					<tr key={k}>
						<td class="prop-key">{k}</td>
						<td class="prop-val">
							{typeof v === "object" ? (
								<pre>{JSON.stringify(v, null, 2)}</pre>
							) : (
								String(v)
							)}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

/**
 * Detail panel for the selected node. Progressive disclosure: identity and
 * summary up front; properties, content, sources, and relationships open on
 * demand. Evidence is presented as-is — interpretation is the reader's.
 */
export function NodePanel({
	controller,
	graphId,
}: {
	controller: VizController;
	graphId: string;
}) {
	const selected = controller.selectedId.value;
	const detail = useSignal<NodeDetail | null>(null);
	const loadError = useSignal<string | null>(null);

	useEffect(() => {
		detail.value = null;
		loadError.value = null;
		if (!selected) return;
		let cancelled = false;
		fetchNodeDetail(graphId, selected)
			.then((d) => {
				if (!cancelled) detail.value = d;
			})
			.catch((e) => {
				if (!cancelled)
					loadError.value = e instanceof Error ? e.message : String(e);
			});
		return () => {
			cancelled = true;
		};
	}, [selected]);

	if (!selected || !controller.graph.hasNode(selected)) return null;
	const n = controller.graph.getNodeAttribute(selected, "node") as VizNode;
	const d = detail.value;
	const props = d?.properties ?? {};
	const knownKeys = new Set([
		"id",
		"name",
		"entity_type",
		"namespace",
		"summary",
		"content",
		"epistemic_status",
		"confidence",
		"assessed_by",
		"created_at",
		"created_by",
		"updated_by",
		"properties",
	]);
	const extraProps = Object.fromEntries(
		Object.entries(props).filter(([k]) => !knownKeys.has(k)),
	);
	const promoted =
		props.properties && typeof props.properties === "object"
			? (props.properties as Record<string, unknown>)
			: {};

	return (
		<aside class="node-panel">
			<button
				type="button"
				class="panel-close"
				onClick={() => {
					controller.selectedId.value = null;
					controller.refresh();
				}}
			>
				×
			</button>

			<div class="panel-head">
				<span
					class="dot dot-lg"
					style={{ background: controller.colorForType(n.entity_type) }}
				/>
				<h2>{n.name}</h2>
			</div>
			<div class="panel-badges">
				{n.entity_type && <span class="badge">{n.entity_type}</span>}
				{n.namespace && <span class="badge badge-ns">{n.namespace}</span>}
				{n.epistemic_status && (
					<span
						class={`badge ${EPISTEMIC_BADGES[n.epistemic_status] ?? ""}`}
						title={
							n.confidence != null
								? `Confidence: ${n.confidence}`
								: "No confidence recorded"
						}
					>
						{n.epistemic_status}
						{n.confidence != null && ` · ${Math.round(n.confidence * 100)}%`}
					</span>
				)}
			</div>

			{((props.summary as string) ?? n.summary) ? (
				<p class="panel-summary">{(props.summary as string) ?? n.summary}</p>
			) : null}

			{loadError.value && (
				<p class="muted">Couldn't load full detail: {loadError.value}</p>
			)}
			{!d && !loadError.value && <div class="spinner spinner-sm" />}

			{d && (
				<>
					{typeof props.content === "string" && props.content && (
						<details>
							<summary>Content</summary>
							<pre class="panel-content">{props.content}</pre>
						</details>
					)}

					{(Object.keys(promoted).length > 0 ||
						Object.keys(extraProps).length > 0) && (
						<details>
							<summary>
								Properties (
								{Object.keys(promoted).length + Object.keys(extraProps).length})
							</summary>
							<PropertyTable data={{ ...promoted, ...extraProps }} />
						</details>
					)}

					{d.tags.length > 0 && (
						<details>
							<summary>Tags ({d.tags.length})</summary>
							<div class="panel-badges">
								{d.tags.map((t) => (
									<span key={t.name} class="badge">
										{t.tag_group ? `${t.tag_group}: ` : ""}
										{t.name}
									</span>
								))}
							</div>
						</details>
					)}

					{d.sources.length > 0 && (
						<details>
							<summary>Sources ({d.sources.length})</summary>
							{d.sources.map((s) => (
								<div key={s.id} class="source-card">
									<div>
										<strong>{s.name}</strong>{" "}
										<span class="muted">{s.source_type}</span>
										{s.confidence != null && (
											<span class="muted">
												{" "}
												· {Math.round(s.confidence * 100)}%
											</span>
										)}
									</div>
									{s.uri && (
										<a href={s.uri} target="_blank" rel="noreferrer">
											{s.uri}
										</a>
									)}
									{s.excerpt && <blockquote>{s.excerpt}</blockquote>}
								</div>
							))}
						</details>
					)}

					{d.relationships.length > 0 && (
						<details>
							<summary>Relationships ({d.relationships.length})</summary>
							<ul class="rel-list">
								{d.relationships.map((r) => (
									<li key={`${r.rel_type}-${r.other_id}-${r.direction}`}>
										<span class="rel-arrow">
											{r.direction === "out" ? "→" : "←"}
										</span>
										<span class="rel-type">{r.rel_type}</span>
										<button
											type="button"
											class="rel-target"
											onClick={() => controller.focusNode(r.other_id)}
										>
											{r.other_name}
										</button>
									</li>
								))}
							</ul>
						</details>
					)}

					<details>
						<summary>Provenance</summary>
						<table class="prop-table">
							<tbody>
								<tr>
									<td class="prop-key">id</td>
									<td class="prop-val">{n.id}</td>
								</tr>
								<tr>
									<td class="prop-key">created</td>
									<td class="prop-val">
										{new Date(d.created_at).toLocaleString()}
									</td>
								</tr>
								{typeof props.created_by === "string" && (
									<tr>
										<td class="prop-key">created by</td>
										<td class="prop-val">{props.created_by}</td>
									</tr>
								)}
								{typeof props.assessed_by === "string" && (
									<tr>
										<td class="prop-key">assessed by</td>
										<td class="prop-val">{props.assessed_by}</td>
									</tr>
								)}
								<tr>
									<td class="prop-key">embedding</td>
									<td class="prop-val">
										{d.has_embedding ? "stored (not shown)" : "none"}
									</td>
								</tr>
							</tbody>
						</table>
					</details>
				</>
			)}
		</aside>
	);
}
