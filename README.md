# NerfWatch

Checks whether an AI model has gotten worse ("nerfed") since you started watching it. It asks the model the same automatically graded questions on a schedule and compares each result with a fixed baseline.

It tests models from Anthropic, OpenAI, xAI and Meta through their own APIs, and any model on OpenRouter, one model per run. Each model gets a full test every day. You choose which; see [Choosing a model](#choosing-a-model).

**See the results at [nerfwatch.lol](https://nerfwatch.lol).** This repository is the engine behind it: run it yourself to watch the models you care about, with your own questions.

## How it works

**100 questions:** 5 kinds × 5 difficulty levels × 4 questions each. Every question has one correct answer, checked by code rather than by another AI.

| Kind | Task | Harder levels mean |
|---|---|---|
| reasoning | Track a list through a series of operations | 12 → 90 operations; from level 2, operations that depend on the values ("remove the largest", "if the sum is even…") |
| logic | Work out who always tells the truth and who always lies, from what they say (knights and knaves) | 4 → 11 people; statements that tie more of them together ("exactly 2 of…", "if… then…") |
| code | Predict what a small Python program prints | more variables, statements and loops; from level 3, bigger numbers and multiplication |
| instructions | Write lines that follow checkable rules (acrostic, word counts, banned letter…) | 2 → 6 rules at once; from level 3, rules that need counting or planning every word (letters per line, alliteration, no repeated words) |
| long-context | Follow a chain of managers through a staff directory | ~3k → ~33k token document, longer chains, and from level 3, finding everyone who reports to someone |

**The baseline** is every finished run in the first 7 days of tracking, for the same model, effort and question set. Change any of those and a new baseline starts. For a model released before you started tracking it, reports say so and show the baseline date: you can't test the past, so scores are compared with that date, not launch day.

**The verdict** compares the last 3 runs with the baseline. A model is only "worse than baseline" when the whole 95% range of the difference is below zero.

**Also recorded for every question:** thinking tokens, input tokens (the questions never change, so a jump means the provider changed how it counts), cost, refusals, answers cut off early, and which model the API says answered. A small live probe also measures response time.

**Settings are pinned** (model, effort, output limit), so a change in the API's defaults can't look like a nerf. Refusal fallbacks are off, because another model stepping in would mean measuring the wrong model.

## Quick start

Needs Node 24 or later.

```bash
npm install
cp .env.example .env    # then add the API key for each provider you'll test
./nerf generate         # creates your question set in data/
./nerf submit           # dry run: shows the estimated cost, sends nothing
./nerf submit --yes     # sends the 100 questions to Claude Opus 5 through the Batch API (half price)
./nerf collect          # once batches are done (usually within an hour): grades them and prints the reports
./nerf probe --yes      # asks 10 of the questions live and measures response time
./nerf report           # prints the latest report again
```

Every request and answer is saved in `runs/<run id>/`, so you can check the grading yourself.

## Choosing a model

Each run tests one model. Pick it with `--model`, and how much it's allowed to think with `--effort`:

```bash
./nerf submit --yes --model gpt-6-astra --effort medium
./nerf probe --yes --model gpt-6-astra --effort medium
```

Use the same `--model` and `--effort` for `submit` and `probe`, so the live probe matches the full runs it sits next to.

| Provider | Models | Key in `.env` | Full runs |
|---|---|---|---|
| Anthropic | `claude-opus-5` (default), `claude-opus-5-5`, `claude-sonnet-5`, `claude-fable-5-1` | `ANTHROPIC_API_KEY` | Batch API, half price |
| OpenAI | `gpt-6-astra`, `gpt-6-sol`, `gpt-5.5` | `OPENAI_API_KEY` | Batch API, half price |
| xAI | `grok-4.7`, `grok-4.6` | `XAI_API_KEY` | live |
| Meta | `muse-spark-1.3`, `muse-spark-1.2` | `META_API_KEY` | live |
| OpenRouter | any model on OpenRouter, as `openrouter/<id>` | `OPENROUTER_API_KEY` | Batch API when the model has one, otherwise live |

`./nerf models` lists the same models with their prices and the thinking levels each one accepts. Levels differ by model (xAI's stop at `xhigh`; some OpenAI models also take `none`), but every model accepts `low`, the default. Low is on purpose: given more room, top models double-check their way to nearly every answer, which leaves the score nowhere to drop, and it costs more. A model that got worse still shows up at `high`, but mostly as more thinking tokens for the same score. Any other model name or level stops before anything is sent.

**Full runs** go through the provider's batch API when NerfWatch uses one: results come back later through `./nerf collect`, at half price. xAI and Meta runs, and OpenRouter models without a batch option, are asked live instead, a few questions at a time, and the report prints as soon as the run finishes. xAI's batch API doesn't document its discount or result format clearly yet, and Meta doesn't have one. On xAI and Meta a full run costs roughly $1–2; on OpenRouter it depends on the model. Live runs that hit a rate limit wait a minute and ask those questions again, up to 3 times.

**OpenRouter:** use the model's OpenRouter id with `openrouter/` in front, for example `--model openrouter/google/gemini-3.1-pro`. Its name, release date and prices come from OpenRouter's model list, and each answer's cost is what OpenRouter reports it charged. Thinking levels are OpenRouter's: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; use `none` for models that don't think.

- **Pin the provider.** OpenRouter can serve a model from different companies and switch between them, and a different provider can score differently, which would look like a nerf. Add `@<provider>` to pin one, for example `openrouter/google/gemini-3.1-pro@google-vertex`, and fallbacks are turned off. Pinned and unpinned runs get separate baselines. When OpenRouter says which provider served an answer, that's saved with it too.
- **Batch API.** When OpenRouter offers a model's `:batch` variant, and your pinned provider serves it, full runs go through OpenRouter's Batch API at half price and come back through `./nerf collect`.
- **Privacy.** Live requests ask OpenRouter to skip providers that may keep or train on your prompts (`data_collection: deny`), and providers that would ignore the thinking level. Batches can't carry that setting (a pinned provider is the only routing option they accept), so OpenRouter applies your account's data policy instead: set it in OpenRouter's privacy settings.

**Meta:** only the Standard tier is supported. Meta's cheaper `-contributor` models may be trained on what you send them, including your questions.

**Testing several models:** run `submit` and `probe` once per model. Each model and effort level gets its own baseline and verdict, since scores are only compared with the same model's earlier runs, never with other models. Costs add up per model. One `./nerf collect` fetches every finished batch, whichever model it's for, and lists the ones still processing.

**Adding a model:** add it to `src/models.ts` with its provider, thinking levels and prices. A model from another provider also needs a client in `src/providers/`. Providers that serve the Responses API, like OpenAI, xAI and Meta, only need an entry in `src/providers/responses.ts`.

## Cost

`submit` and `probe` show an estimate and send nothing unless you add `--yes`. For example, on Claude Opus 5 the estimate is about $3 for a batch run of 100 questions and $0.40 for a live probe. How much the model thinks is the biggest factor, so check the first report for the real number. Each report gives the real cost and projects a monthly cost per model for a run every day.

Prices live in `src/models.ts` (list prices, September 2026), with links to each provider's pricing page. Update them when they change.

## Your question set

- `generate` picks a random seed and saves it with the questions in `data/questions.json`. The generators are public, so the seed is what makes your set different from anyone else's. `data/` and `runs/` are gitignored, so they don't end up in a commit by accident.
- Don't regenerate after your baseline starts. New questions can't be compared with old scores, so `generate` won't overwrite an existing set without `--force`.
- Every question goes to the company that answers it, or through OpenRouter to whichever provider serves it.

## Tune the difficulty first

The first report shows how many questions the model passes at each level. A level it passes 5/5 is too easy and 0/5 is too hard; neither can show a drop. Adjust the difficulty in `src/questions/` (each file has a `LEVELS` table at the top), run `./nerf generate --force`, and only then start your baseline. With a run every day, the baseline week has 7 runs, 700 answers.

## Run it on a schedule

For example, a full run every day with cron:

```
0 6 * * *          cd /path/to/nerf-watch && ./nerf submit --yes
0 12 * * *         cd /path/to/nerf-watch && ./nerf collect
0 0,6,12,18 * * *  cd /path/to/nerf-watch && ./nerf probe --yes
```

This tests the default model. For another model, add `--model <id>` to the `submit` and `probe` lines, and give each model its own lines. The single `collect` line covers all of them; a batch that isn't done yet is picked up on the next run.

## Limitations

- It tests the API, not chat apps like Claude.ai, which add their own instructions and routing. It can't see subscription usage limits.
- A verdict says that a score changed, not why.
- Model lists and prices change often. Check `src/models.ts` against the providers' pricing pages now and then.

## Project layout

| Path | What's in it |
|---|---|
| `src/questions/` | Question generators and graders, one file per kind |
| `src/models.ts` | Every supported model: provider, thinking levels, prices |
| `src/providers/` | One client per API: `anthropic.ts` for Claude, `responses.ts` for OpenAI, xAI and Meta, `openrouter.ts` for OpenRouter |
| `src/run.ts` | What all providers share: runs, results, grading an answer, cost estimates |
| `src/analysis.ts` | Baselines, comparisons and verdicts |
| `src/report.ts` | The plain-text reports |
| `src/cli.ts` | The `./nerf` commands |

## Development

```bash
npm test           # checks every generator and grader; the code questions are verified against real Python
npm run typecheck
```

TypeScript runs directly on Node, with no build step.

## Contributing

Pull requests are welcome: new models and providers, new kinds of questions, better graders, bug fixes and clearer docs. For anything big, open an issue first so we can agree on the approach before you spend time on it.

**Rules for pull requests**

- **Never include your own data:** your question set or its seed, run results, or anything else from `data/` or `runs/`. (The tests use seed 1 on purpose, as a public example.) No API keys either, not even expired ones.
- **Tests run offline.** They can't call a real API, need a key, or cost money. Use recorded or hand-written responses, like `tests/providers.test.ts` does.
- **`npm test` and `npm run typecheck` pass.** Add tests for what you change. New generators and graders need tests showing the expected answers are right and that wrong answers fail.
- **Say so if scores could shift.** A change to a grader, a generator, or the default settings can move scores for the same model, which looks like the model changed when it didn't. Call it out in the pull request so it can go in the release notes.
- **Grading stays with code.** Every question needs one answer that code can check. No grading by another AI: it can drift too, and then we can't tell which model changed.
- **Link your sources for models.** When you add or update a model in `src/models.ts`, link the provider's official page for its prices and thinking levels in the pull request.
- **Keep it small.** One change per pull request, no new dependencies unless there's no reasonable alternative, and no build step.
- **Use semantic commit messages**, like `feat: add grok-4.8` or `fix: count cache writes for GPT-6`.

## License

MIT
