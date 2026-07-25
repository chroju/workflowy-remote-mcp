import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run inside workerd so D1 behaves exactly as it does in production
// (fts5, trigram tokenizer, batch semantics).
//
// Deliberately not pointed at wrangler.jsonc: the real config carries
// Durable Objects, KV and the OAuth provider, none of which the unit
// tests exercise. Only the D1 mirror binding is needed here.
export default defineConfig({
	plugins: [
		cloudflareTest({
			miniflare: {
				compatibilityDate: "2025-03-10",
				compatibilityFlags: ["nodejs_compat"],
				d1Databases: ["DB"],
			},
		}),
	],
});
