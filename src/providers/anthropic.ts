// Claude, through Anthropic's own SDK: Message Batches (half price) and streamed live answers.
import Anthropic from "@anthropic-ai/sdk";
import type { TokenUsage } from "../models.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import { answerResult, errorResult, stopwatch, type ProviderClient, type Result, type Settings } from "../run.ts";

type Effort = NonNullable<Anthropic.Messages.OutputConfig["effort"]>;

// No refusal fallbacks on purpose: if another model stepped in, we'd be measuring the wrong model.
export function buildParams(q: Question, set: QuestionSet, settings: Settings): Anthropic.MessageCreateParamsNonStreaming {
  const content: Anthropic.TextBlockParam[] = [];
  if (q.documentId) {
    content.push({ type: "text", text: set.documents[q.documentId], cache_control: { type: "ephemeral" } });
  }
  content.push({ type: "text", text: q.prompt });

  return {
    model: settings.model,
    max_tokens: settings.maxTokens,
    thinking: { type: "adaptive" },
    output_config: { effort: settings.effort as Effort }, // checked against the model's list in models.ts
    messages: [{ role: "user", content }],
  };
}

function toResult(q: Question, message: Anthropic.Message, settings: Settings, batch: boolean): Result {
  const answer = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const usage: TokenUsage = {
    input: message.usage.input_tokens,
    cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
    cacheRead: message.usage.cache_read_input_tokens ?? 0,
    output: message.usage.output_tokens,
    thinking: message.usage.output_tokens_details?.thinking_tokens ?? 0,
  };
  return answerResult(q, answer, message.stop_reason, usage, settings, message.model, batch);
}

export function anthropicProvider(): ProviderClient {
  const client = new Anthropic();

  return {
    // Free call. Also fails early, before any spend, if the model id is wrong.
    async fetchModelInfo(model) {
      const info = await client.models.retrieve(model);
      return {
        modelName: info.display_name,
        modelReleasedAt: new Date(info.created_at).getTime() > 0 ? info.created_at : undefined, // epoch means unknown
      };
    },

    async runLive(q, set, settings) {
      const timer = stopwatch();
      try {
        const stream = client.messages.stream(buildParams(q, set, settings));
        stream.on("text", timer.firstText);
        const message = await stream.finalMessage();
        return { ...toResult(q, message, settings, false), latency: timer.latency() };
      } catch (error) {
        if (error instanceof Anthropic.APIError) return errorResult(q, `${error.status ?? ""} ${error.message}`.trim());
        throw error;
      }
    },

    batch: {
      async submit(set, questions, settings) {
        const batch = await client.messages.batches.create({
          requests: questions.map((q) => ({ custom_id: q.id, params: buildParams(q, set, settings) })),
        });
        return batch.id;
      },

      async collect(run, set) {
        const batch = await client.messages.batches.retrieve(run.batchId!);
        if (batch.processing_status !== "ended") {
          const c = batch.request_counts;
          return { done: false, counts: { processing: c.processing, succeeded: c.succeeded, errored: c.errored } };
        }

        const byId = new Map(set.questions.map((q) => [q.id, q]));
        const results: Result[] = [];
        // Results arrive in any order, so match them by id.
        for await (const item of await client.messages.batches.results(run.batchId!)) {
          const q = byId.get(item.custom_id);
          if (!q) continue;
          if (item.result.type === "succeeded") results.push(toResult(q, item.result.message, run.settings, true));
          else if (item.result.type === "errored") results.push(errorResult(q, JSON.stringify(item.result.error)));
          else results.push(errorResult(q, item.result.type)); // canceled or expired
        }
        return { done: true, results };
      },
    },
  };
}
