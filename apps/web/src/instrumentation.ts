/**
 * Runs once when the server starts. Building the container validates the environment, so a bad
 * configuration (for example MOCK_LLM in production) stops the server instead of failing requests.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getContainer } = await import("./lib/container");
    getContainer();
  }
}
