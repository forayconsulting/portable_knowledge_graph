const VALID_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface PromotedProperties {
	setClauses: string[];
	params: Record<string, string | number | boolean>;
	propKeys: string[];
	jsonFallback: string | null;
}

export function promoteProperties(
	properties: Record<string, unknown> | undefined,
	nodeAlias = "e",
): PromotedProperties {
	if (!properties)
		return { setClauses: [], params: {}, propKeys: [], jsonFallback: null };

	const setClauses: string[] = [];
	const params: Record<string, string | number | boolean> = {};
	const propKeys: string[] = [];
	const nonPromotable: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(properties)) {
		if (!VALID_KEY.test(key)) {
			nonPromotable[key] = value;
			continue;
		}
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			const paramName = `prop_${key}`;
			setClauses.push(`${nodeAlias}.prop_${key} = $${paramName}`);
			params[paramName] = value;
			propKeys.push(key);
		} else if (value !== null && value !== undefined) {
			nonPromotable[key] = value;
		}
	}

	return {
		setClauses,
		params,
		propKeys,
		jsonFallback: Object.keys(nonPromotable).length
			? JSON.stringify(nonPromotable)
			: null,
	};
}

// Setting a property to null removes it in Neo4j. Used on update to clear
// promoted prop_* fields that are no longer present in the new properties.
export function buildStalePropRemoval(
	prevKeys: string[] | null | undefined,
	newKeys: string[],
	nodeAlias = "e",
): string[] {
	if (!prevKeys?.length) return [];
	const next = new Set(newKeys);
	return prevKeys
		.filter((k) => VALID_KEY.test(k) && !next.has(k))
		.map((k) => `${nodeAlias}.prop_${k} = null`);
}

export function buildPropertyFilter(
	filter: Record<string, string | number | boolean> | undefined,
	nodeAlias = "node",
): {
	whereClauses: string[];
	params: Record<string, string | number | boolean>;
} {
	if (!filter) return { whereClauses: [], params: {} };

	const whereClauses: string[] = [];
	const params: Record<string, string | number | boolean> = {};

	for (const [key, value] of Object.entries(filter)) {
		if (!VALID_KEY.test(key)) continue;
		const paramName = `pf_${key}`;
		whereClauses.push(`${nodeAlias}.prop_${key} = $${paramName}`);
		params[paramName] = value;
	}

	return { whereClauses, params };
}
