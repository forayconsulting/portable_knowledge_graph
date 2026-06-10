import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CypherCapture, cypherTrace } from "./trace";

export interface VizEdgeRef {
	from: string;
	to: string;
	rel_type?: string;
}

export interface VizCypher {
	statement: string;
	params?: string;
}

export interface VizEvent {
	id: string;
	ts: string;
	graph_id: string;
	email: string;
	tool: string;
	action?: string;
	args_preview?: string;
	node_ids: string[];
	edges: VizEdgeRef[];
	cypher: VizCypher[];
	duration_ms: number;
	is_error: boolean;
}

export type VizEmitter = (event: VizEvent) => void;

const MAX_NODE_IDS = 300;
const MAX_EDGES = 500;
const MAX_STATEMENTS = 12;
const MAX_STATEMENT_CHARS = 2000;
const MAX_PARAMS_CHARS = 1000;
const MAX_ARGS_PREVIEW_CHARS = 300;
const MAX_WALK_DEPTH = 8;

/**
 * Best-effort extraction of node ids and edge references from a parsed tool
 * result. Tool-agnostic: any object with a string `id` counts as a touched
 * node; any object with string `from` and `to` counts as a touched edge.
 * False positives are harmless — the viz client ignores ids it can't find.
 */
export function extractTouched(value: unknown): {
	node_ids: string[];
	edges: VizEdgeRef[];
} {
	const nodeIds = new Set<string>();
	const edges: VizEdgeRef[] = [];
	const seenEdges = new Set<string>();

	const walk = (v: unknown, depth: number): void => {
		if (depth > MAX_WALK_DEPTH || v === null || typeof v !== "object") return;
		if (nodeIds.size >= MAX_NODE_IDS && edges.length >= MAX_EDGES) return;

		if (Array.isArray(v)) {
			for (const item of v) walk(item, depth + 1);
			return;
		}

		const obj = v as Record<string, unknown>;
		if (typeof obj.from === "string" && typeof obj.to === "string") {
			const relType =
				typeof obj.rel_type === "string"
					? obj.rel_type
					: typeof obj.type === "string"
						? obj.type
						: undefined;
			const key = `${obj.from}→${obj.to}→${relType ?? ""}`;
			if (!seenEdges.has(key) && edges.length < MAX_EDGES) {
				seenEdges.add(key);
				edges.push({ from: obj.from, to: obj.to, rel_type: relType });
			}
			if (nodeIds.size < MAX_NODE_IDS) nodeIds.add(obj.from);
			if (nodeIds.size < MAX_NODE_IDS) nodeIds.add(obj.to);
		}
		if (typeof obj.id === "string" && nodeIds.size < MAX_NODE_IDS) {
			nodeIds.add(obj.id);
		}
		for (const child of Object.values(obj)) {
			walk(child, depth + 1);
		}
	};

	walk(value, 0);
	return { node_ids: [...nodeIds], edges };
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

function safeJson(value: unknown, max: number): string | undefined {
	try {
		const s = JSON.stringify(value);
		return s ? truncate(s, max) : undefined;
	} catch {
		return undefined;
	}
}

interface ToolResultLike {
	content?: Array<{ type?: string; text?: string }>;
	isError?: boolean;
}

export function buildVizEvent(opts: {
	graphId: string;
	email: string;
	tool: string;
	args: unknown;
	result: ToolResultLike | undefined;
	capture: CypherCapture;
	durationMs: number;
	errored: boolean;
}): VizEvent {
	let touched: { node_ids: string[]; edges: VizEdgeRef[] } = {
		node_ids: [],
		edges: [],
	};
	const text = opts.result?.content?.find(
		(c) => c.type === "text" && typeof c.text === "string",
	)?.text;
	if (text && !opts.result?.isError) {
		try {
			touched = extractTouched(JSON.parse(text));
		} catch {
			// non-JSON tool output — no highlight targets
		}
	}

	const argsObj =
		opts.args && typeof opts.args === "object"
			? (opts.args as Record<string, unknown>)
			: undefined;
	const action =
		typeof argsObj?.action === "string" ? argsObj.action : undefined;

	const cypher: VizCypher[] = opts.capture.statements
		.slice(0, MAX_STATEMENTS)
		.map((s) => ({
			statement: truncate(s.statement, MAX_STATEMENT_CHARS),
			params: s.params ? safeJson(s.params, MAX_PARAMS_CHARS) : undefined,
		}));

	return {
		id: crypto.randomUUID(),
		ts: new Date().toISOString(),
		graph_id: opts.graphId,
		email: opts.email,
		tool: opts.tool,
		action,
		args_preview: safeJson(argsObj, MAX_ARGS_PREVIEW_CHARS),
		node_ids: touched.node_ids,
		edges: touched.edges,
		cypher,
		duration_ms: opts.durationMs,
		is_error: opts.errored || opts.result?.isError === true,
	};
}

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Wraps an McpServer so every handler registered via server.tool() is
 * instrumented: Cypher statements are captured via AsyncLocalStorage, the
 * result is mined for touched node/edge ids, and a VizEvent is emitted.
 *
 * The emit path is entirely best-effort — it can never alter, delay
 * meaningfully, or fail the tool call. The handler's result is returned
 * unchanged.
 */
export function wrapServerForViz(
	server: McpServer,
	opts: { graphId: string; email: string; emit: VizEmitter },
): McpServer {
	return new Proxy(server, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			if (prop !== "tool") return value.bind(target);

			const emitSafely = (
				toolName: string,
				args: unknown,
				result: ToolResultLike | undefined,
				capture: CypherCapture,
				start: number,
				errored = result === undefined,
			): void => {
				try {
					opts.emit(
						buildVizEvent({
							graphId: opts.graphId,
							email: opts.email,
							tool: toolName,
							args,
							result,
							capture,
							durationMs: Date.now() - start,
							errored,
						}),
					);
				} catch {
					// viz emission must never affect tool execution
				}
			};

			return (...toolArgs: unknown[]) => {
				const toolName = typeof toolArgs[0] === "string" ? toolArgs[0] : "?";
				// The handler is the last function argument across all overloads.
				let handlerIdx = -1;
				for (let i = toolArgs.length - 1; i >= 0; i--) {
					if (typeof toolArgs[i] === "function") {
						handlerIdx = i;
						break;
					}
				}
				if (handlerIdx === -1) {
					return (value as AnyFn).apply(target, toolArgs);
				}

				const handler = toolArgs[handlerIdx] as AnyFn;
				toolArgs[handlerIdx] = async (...handlerArgs: unknown[]) => {
					const capture: CypherCapture = { statements: [] };
					const start = Date.now();
					let result: unknown;
					let errored = false;
					try {
						result = await cypherTrace.run(capture, () =>
							handler(...handlerArgs),
						);
					} catch (e) {
						errored = true;
						emitSafely(toolName, handlerArgs[0], undefined, capture, start);
						throw e;
					}
					emitSafely(
						toolName,
						handlerArgs[0],
						result as ToolResultLike,
						capture,
						start,
						errored,
					);
					return result;
				};
				return (value as AnyFn).apply(target, toolArgs);
			};
		},
	});
}
