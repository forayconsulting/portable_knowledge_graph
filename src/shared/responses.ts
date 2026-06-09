export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	[key: string]: unknown;
}

export function ok(data: unknown, opts?: { pretty?: boolean }): ToolResult {
	return {
		content: [
			{
				type: "text" as const,
				text: opts?.pretty
					? JSON.stringify(data, null, 2)
					: JSON.stringify(data),
			},
		],
	};
}

export function err(
	message: string,
	opts?: { not_found?: string[]; suggestion?: string },
): ToolResult {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({
					error: message,
					...(opts?.not_found?.length ? { not_found: opts.not_found } : {}),
					...(opts?.suggestion ? { suggestion: opts.suggestion } : {}),
				}),
			},
		],
		isError: true,
	};
}

export function missingParams(action: string, params: string[]): ToolResult {
	return err(
		`${params.join(", ")} ${params.length > 1 ? "are" : "is"} required for ${action}`,
	);
}

export function toolError(tool: string, error: unknown): ToolResult {
	return err(
		`${tool} error: ${error instanceof Error ? error.message : String(error)}`,
	);
}

export function paginated<T>(
	items: T[],
	opts: {
		total_count?: number;
		offset: number;
		limit: number;
		has_more: boolean;
	},
	extra?: Record<string, unknown>,
): ToolResult {
	return ok({
		results: items,
		count: items.length,
		...(opts.total_count !== undefined
			? { total_count: opts.total_count }
			: {}),
		offset: opts.offset,
		limit: opts.limit,
		has_more: opts.has_more,
		...extra,
	});
}
