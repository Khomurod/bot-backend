import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Component-test runner (npm test --prefix admin). jsdom stands in for the
// browser so React render + keyboard behavior is testable without one.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // BOTH EXTENSIONS. A `.test.js` under src/ matched nothing and was
    // silently not run — a test that cannot fail is worse than no test,
    // because it reads as coverage. Nothing was hidden when this was
    // widened; the point is that nothing can be.
    include: ["src/**/*.test.{js,jsx}"],
    setupFiles: ["./vitest.setup.js"],
    globals: true,
  },
});
