export function buildOpenAIResponse(stream: boolean, text = "ok") {
  if (stream) {
    return new Response(
      `data: ${JSON.stringify({
        id: "chatcmpl-stream",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: text } }],
      })}\n\ndata: [DONE]\n\n`,
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }
    );
  }
  return new Response(
    JSON.stringify({
      id: "chatcmpl-json",
      object: "chat.completion",
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 4,
        completion_tokens: 2,
        total_tokens: 6,
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}
