import { beforeEach, describe, expect, it, vi } from "vitest";
import { RailwayClient } from "../railway";

const TOKEN = "test-railway-token";

let lastFetchArgs: { url: string; init: RequestInit } | null = null;

function mockFetch(data: unknown, errors?: Array<{ message: string }>) {
	return vi.fn().mockResolvedValue({
		ok: true,
		json: () => Promise.resolve({ data, errors }),
	});
}

function mockFetchError(status: number, body: string) {
	return vi.fn().mockResolvedValue({
		ok: false,
		status,
		text: () => Promise.resolve(body),
	});
}

beforeEach(() => {
	lastFetchArgs = null;
});

describe("RailwayClient", () => {
	it("sends Bearer token in Authorization header", async () => {
		const spy = mockFetch({
			projectCreate: {
				id: "proj-1",
				environments: { edges: [{ node: { id: "env-1" } }] },
			},
		});
		vi.stubGlobal("fetch", spy);

		const client = new RailwayClient(TOKEN);
		await client.createProject("test-project");

		expect(spy).toHaveBeenCalledOnce();
		const [url, init] = spy.mock.calls[0];
		expect(url).toBe("https://backboard.railway.com/graphql/v2");
		expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);

		vi.unstubAllGlobals();
	});

	it("createProject sends projectCreate mutation", async () => {
		const spy = mockFetch({
			projectCreate: {
				id: "proj-1",
				environments: { edges: [{ node: { id: "env-1" } }] },
			},
		});
		vi.stubGlobal("fetch", spy);

		const client = new RailwayClient(TOKEN);
		const result = await client.createProject("my-graph");

		expect(result).toEqual({ projectId: "proj-1", environmentId: "env-1" });
		const body = JSON.parse(spy.mock.calls[0][1].body);
		expect(body.query).toContain("projectCreate");

		vi.unstubAllGlobals();
	});

	it("deleteProject sends projectDelete mutation", async () => {
		const spy = mockFetch({ projectDelete: true });
		vi.stubGlobal("fetch", spy);

		const client = new RailwayClient(TOKEN);
		await client.deleteProject("proj-1");

		const body = JSON.parse(spy.mock.calls[0][1].body);
		expect(body.query).toContain("projectDelete");
		expect(body.variables).toEqual({ id: "proj-1" });

		vi.unstubAllGlobals();
	});

	it("throws on HTTP error", async () => {
		vi.stubGlobal("fetch", mockFetchError(500, "Internal Server Error"));

		const client = new RailwayClient(TOKEN);
		await expect(client.createProject("fail")).rejects.toThrow(
			"Railway API 500",
		);

		vi.unstubAllGlobals();
	});

	it("throws on GraphQL errors", async () => {
		const spy = mockFetch(null, [{ message: "Rate limit exceeded" }]);
		vi.stubGlobal("fetch", spy);

		const client = new RailwayClient(TOKEN);
		await expect(client.createProject("fail")).rejects.toThrow(
			"Rate limit exceeded",
		);

		vi.unstubAllGlobals();
	});

	it("createService sends serviceCreate mutation with image source", async () => {
		const spy = mockFetch({ serviceCreate: { id: "svc-1" } });
		vi.stubGlobal("fetch", spy);

		const client = new RailwayClient(TOKEN);
		const result = await client.createService("proj-1", "neo4j:5-community");

		expect(result).toEqual({ serviceId: "svc-1" });
		const body = JSON.parse(spy.mock.calls[0][1].body);
		expect(body.query).toContain("serviceCreate");

		vi.unstubAllGlobals();
	});

	it("createServiceDomain returns domain string", async () => {
		const spy = mockFetch({
			serviceDomainCreate: { domain: "neo4j-abc.up.railway.app" },
		});
		vi.stubGlobal("fetch", spy);

		const client = new RailwayClient(TOKEN);
		const result = await client.createServiceDomain("svc-1", "env-1");

		expect(result).toEqual({ domain: "neo4j-abc.up.railway.app" });

		vi.unstubAllGlobals();
	});
});
