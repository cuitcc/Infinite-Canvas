export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startVideoPoller } = await import("./lib/poll");
    startVideoPoller();
  }
}
