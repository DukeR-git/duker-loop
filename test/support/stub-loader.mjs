// Module resolver hook: redirects the pi-bundled packages to minimal stubs under ./stubs so the
// extension can be exercised by plain `node --test` without a pi installation.
const STUBS = {
	"@earendil-works/pi-coding-agent": "./stubs/pi-coding-agent.mjs",
	"@earendil-works/pi-tui": "./stubs/pi-tui.mjs",
	"@earendil-works/pi-agent-core": "./stubs/empty.mjs",
	"@earendil-works/pi-ai": "./stubs/empty.mjs",
	typebox: "./stubs/typebox.mjs",
};

export async function resolve(specifier, context, next) {
	const stub = STUBS[specifier];
	if (stub) return { url: new URL(stub, import.meta.url).href, shortCircuit: true };
	return next(specifier, context);
}
