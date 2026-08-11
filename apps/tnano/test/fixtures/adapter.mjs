export default {
  manifest: {
    apiVersion: 1,
    id: "fixture",
    label: "Fixture",
    version: "1.0.0",
    capabilities: ["streaming"],
  },
  probe() {
    return { status: "ready" };
  },
  open({ sessionId }) {
    return {
      binding: { nativeSessionId: `fixture:${sessionId}` },
      async *run({ text }) {
        yield { type: "content.delta", text: `fixture: ${text}` };
        yield { type: "turn.state", state: "completed" };
      },
    };
  },
};
