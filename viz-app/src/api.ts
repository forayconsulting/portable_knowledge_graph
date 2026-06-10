import type { Meta, NodeDetail, Snapshot } from "./types";

export function graphIdFromUrl(): string {
	const match = location.pathname.match(/^\/viz\/([a-z0-9][a-z0-9-]*)/);
	return match ? match[1] : "default";
}

const MAX_PAGES = 3;

async function getJson<T>(path: string): Promise<T> {
	const res = await fetch(path, { headers: { Accept: "application/json" } });
	if (!res.ok) {
		let message = `${res.status}`;
		try {
			const body = (await res.json()) as { error?: string };
			if (body.error) message = body.error;
		} catch {
			// non-JSON error body
		}
		throw new Error(message);
	}
	return res.json() as Promise<T>;
}

export function fetchMeta(graphId: string): Promise<Meta> {
	return getJson<Meta>(`/viz/api/${graphId}/meta`);
}

export async function fetchSnapshot(graphId: string): Promise<Snapshot> {
	let cursor: string | null = null;
	const all: Snapshot = {
		nodes: [],
		edges: [],
		has_more: false,
		next_cursor: null,
	};
	for (let page = 0; page < MAX_PAGES; page++) {
		const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
		const part: Snapshot = await getJson<Snapshot>(
			`/viz/api/${graphId}/graph${qs}`,
		);
		all.nodes.push(...part.nodes);
		if (page === 0) all.edges = part.edges;
		all.has_more = part.has_more;
		cursor = part.next_cursor;
		if (!part.has_more || !cursor) break;
	}
	return all;
}

export function fetchNodeDetail(
	graphId: string,
	nodeId: string,
): Promise<NodeDetail> {
	return getJson<NodeDetail>(
		`/viz/api/${graphId}/node/${encodeURIComponent(nodeId)}`,
	);
}
