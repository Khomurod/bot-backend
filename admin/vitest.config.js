import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Component-test runner (npm test --prefix admin). jsdom stands in for the
// browser so React render + keyboard behavior is testable without one.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.jsx"],
    setupFiles: ["./vitest.setup.js"],
    globals: true,
  },
});
