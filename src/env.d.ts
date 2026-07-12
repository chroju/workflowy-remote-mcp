// Secrets are not included in the `wrangler types` output; declare them here
// so they merge into both the generated global Env interface and the
// Cloudflare.Env used by `import { env } from "cloudflare:workers"`.
interface Env {
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	COOKIE_ENCRYPTION_KEY: string;
	WORKFLOWY_API_KEY: string;
	ALLOWED_GITHUB_USERS: string;
}

declare namespace Cloudflare {
	interface Env {
		GITHUB_CLIENT_ID: string;
		GITHUB_CLIENT_SECRET: string;
		COOKIE_ENCRYPTION_KEY: string;
		WORKFLOWY_API_KEY: string;
		ALLOWED_GITHUB_USERS: string;
	}
}
