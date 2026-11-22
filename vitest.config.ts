import { defineConfig } from "vitest/config";

// The integration test builds real pi sessions (model runtime, resource loader); give it room on Windows.
export default defineConfig({
	test: {
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
