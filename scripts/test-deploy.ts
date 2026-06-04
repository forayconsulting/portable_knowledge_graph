#!/usr/bin/env npx tsx
/**
 * Deployment smoke test for the multi-tenant KG platform.
 *
 * Prerequisites:
 *   - Both workers deployed (kg-factory + kg-mcp)
 *   - Cloudflare Access Service Token created
 *
 * Usage:
 *   CF_ACCESS_CLIENT_ID=xxx CF_ACCESS_CLIENT_SECRET=yyy npx tsx scripts/test-deploy.ts
 *
 * Optional env vars:
 *   FACTORY_URL  — default: https://kg-factory.foray-consulting.workers.dev
 *   MCP_URL      — default: https://kg-mcp.foray-consulting.workers.dev
 *   TEST_GRAPH   — graph ID to provision (default: smoke-test-<timestamp>)
 */

const FACTORY_URL =
	process.env.FACTORY_URL ?? "https://kg-factory.foray-consulting.workers.dev";
const MCP_URL =
	process.env.MCP_URL ?? "https://kg-mcp.foray-consulting.workers.dev";
const CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID;
const CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET;
const TEST_GRAPH =
	process.env.TEST_GRAPH ?? `smoke-test-${Math.floor(Date.now() / 1000)}`;

if (!CLIENT_ID || !CLIENT_SECRET) {
	console.error(
		"Error: CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required",
	);
	console.error(
		"Create a service token at: Cloudflare Zero Trust → Access → Service Auth → Service Tokens",
	);
	process.exit(1);
}

const AUTH_HEADERS = {
	"CF-Access-Client-Id": CLIENT_ID,
	"CF-Access-Client-Secret": CLIENT_SECRET,
};

let passed = 0;
let failed = 0;

function log(msg: string) {
	console.log(`  ${msg}`);
}

function pass(name: string) {
	passed++;
	console.log(`✓ ${name}`);
}

function fail(name: string, reason: string) {
	failed++;
	console.error(`✗ ${name}: ${reason}`);
}

async function fetchJson(
	url: string,
	opts: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await fetch(url, {
		...opts,
		headers: {
			...AUTH_HEADERS,
			...((opts.headers as Record<string, string>) ?? {}),
		},
	});
	const text = await res.text();
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(text);
	} catch {
		body = { _raw: text };
	}
	return { status: res.status, body };
}

async function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testFactoryHealth() {
	const name = "Factory /health returns 200";
	try {
		const { status, body } = await fetchJson(`${FACTORY_URL}/health`);
		if (status === 200 && body.status === "ok") pass(name);
		else fail(name, `status=${status} body=${JSON.stringify(body)}`);
	} catch (e) {
		fail(name, String(e));
	}
}

async function testMcpHealth() {
	const name = "MCP /health returns 200 with neo4j connected";
	try {
		const { status, body } = await fetchJson(`${MCP_URL}/health`);
		if (status === 200 && body.neo4j === "connected") pass(name);
		else fail(name, `status=${status} body=${JSON.stringify(body)}`);
	} catch (e) {
		fail(name, String(e));
	}
}

async function testProvisionAndTeardown() {
	const provisionName = `POST /graphs returns 202 (graph: ${TEST_GRAPH})`;
	let provisioned = false;

	// --- Provision ---
	try {
		const { status, body } = await fetchJson(`${FACTORY_URL}/graphs`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				graph_id: TEST_GRAPH,
				display_name: "Smoke Test Graph",
				users: {},
				default_role: null,
			}),
		});

		if (status === 202 && body.graph_id === TEST_GRAPH) {
			pass(provisionName);
			log(`workflow_id: ${body.workflow_id}`);
			provisioned = true;
		} else {
			fail(provisionName, `status=${status} body=${JSON.stringify(body)}`);
			return;
		}
	} catch (e) {
		fail(provisionName, String(e));
		return;
	}

	// --- Poll until ready ---
	const pollName = "Provisioning reaches 'ready' state";
	const maxWaitMs = 12 * 60 * 1000; // 12 minutes (Neo4j boot takes 5-10 min)
	const pollInterval = 15_000; // 15 seconds
	const startTime = Date.now();
	let lastState = "";
	let lastStep = "";

	while (Date.now() - startTime < maxWaitMs) {
		await sleep(pollInterval);
		try {
			const { body } = await fetchJson(`${FACTORY_URL}/graphs/${TEST_GRAPH}`);
			const state = body.state as string;
			const step = (body.provision_step as string) ?? "";
			const elapsed = `${Math.round((Date.now() - startTime) / 1000)}s`;

			if (state !== lastState) {
				log(`state: ${lastState || "(initial)"} → ${state} (${elapsed})`);
				lastState = state;
			}
			if (step && step !== lastStep) {
				log(`  step: ${step} (${elapsed})`);
				lastStep = step;
			}

			if (state === "ready") {
				pass(pollName);
				break;
			}
			if (state === "failed") {
				fail(
					pollName,
					`Provisioning failed at step "${step}": ${body.error_message}`,
				);
				break;
			}
		} catch (e) {
			log(`poll error: ${e}`);
		}
	}

	if (lastState !== "ready" && lastState !== "failed") {
		fail(
			pollName,
			`Timed out after ${maxWaitMs / 1000}s — last state: ${lastState}`,
		);
	}

	// --- List graphs ---
	const listName = "GET /graphs lists the provisioned graph";
	try {
		const { body } = await fetchJson(`${FACTORY_URL}/graphs`);
		const graphs = body as unknown as Array<{ graph_id: string }>;
		if (
			Array.isArray(graphs) &&
			graphs.some((g) => g.graph_id === TEST_GRAPH)
		) {
			pass(listName);
		} else {
			fail(listName, `Graph not in list: ${JSON.stringify(body)}`);
		}
	} catch (e) {
		fail(listName, String(e));
	}

	// --- Teardown ---
	if (!provisioned) return;

	const teardownName = "DELETE /graphs tears down cleanly";
	try {
		const { status, body } = await fetchJson(
			`${FACTORY_URL}/graphs/${TEST_GRAPH}`,
			{
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirm_graph_id: TEST_GRAPH }),
			},
		);

		if (status === 200 && body.deleted === true) {
			pass(teardownName);
		} else {
			fail(teardownName, `status=${status} body=${JSON.stringify(body)}`);
		}
	} catch (e) {
		fail(teardownName, String(e));
	}

	// --- Verify deletion ---
	const gone404Name = "GET /graphs/{id} returns 404 after deletion";
	try {
		const { status } = await fetchJson(`${FACTORY_URL}/graphs/${TEST_GRAPH}`);
		if (status === 404) pass(gone404Name);
		else fail(gone404Name, `Expected 404 but got ${status}`);
	} catch (e) {
		fail(gone404Name, String(e));
	}
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
	console.log("=== Multi-Tenant KG Platform — Deployment Smoke Test ===\n");
	console.log(`Factory: ${FACTORY_URL}`);
	console.log(`MCP:     ${MCP_URL}`);
	console.log(`Graph:   ${TEST_GRAPH}\n`);

	await testFactoryHealth();
	await testMcpHealth();
	await testProvisionAndTeardown();

	console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
	console.error("Fatal:", e);
	process.exit(1);
});
