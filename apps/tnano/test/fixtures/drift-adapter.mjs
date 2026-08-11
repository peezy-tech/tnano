export default {
  manifest: {
    apiVersion: 1,
    id: "drift-fixture",
    label: "Drift fixture",
    version: "1.0.0",
    capabilities: [],
  },
  probe() {
    return {
      status: "ready",
      account: { id: process.env.TNANO_DRIFT_TEST_ACCOUNT ?? "missing-test-account" },
    };
  },
  open() {
    return {
      async *run() {
        yield { type: "turn.state", state: "completed" };
      },
    };
  },
};
