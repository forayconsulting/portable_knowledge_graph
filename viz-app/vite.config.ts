import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [preact()],
	// The Worker serves the SPA under /viz/<graph-id>; assets resolve to /viz/assets/*
	base: "/viz/",
	build: {
		outDir: "../public/viz",
		emptyOutDir: true,
	},
	server: {
		// Standalone frontend dev against a local `wrangler dev` backend.
		// The Access email header is injected here because Cloudflare Access
		// only fronts the deployed Worker — local dev has no Access layer.
		proxy: {
			"/viz/api": {
				target: "http://localhost:8787",
				headers: { "CF-Access-Authenticated-User-Email": "dev@localhost" },
			},
			"/viz/ws": {
				target: "ws://localhost:8787",
				ws: true,
				headers: { "CF-Access-Authenticated-User-Email": "dev@localhost" },
			},
		},
	},
});
