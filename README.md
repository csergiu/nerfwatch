# NerfWatch

Checks whether an AI model has gotten worse ("nerfed") since you started watching it. It asks the model the same private, automatically graded questions on a schedule and compares each result with a fixed baseline.

It currently works with Anthropic's Claude models, through the API.

## How it works

**100 questions:** 4 kinds × 5 difficulty levels × 5 questions each. Every question has one correct answer, checked by code rather than by another AI.

| Kind | Task | Harder levels mean |
|---|---|---|
| reasoning | Track a list through a series of operations | 8 → 64 operations |
| code | Predict what a small Python program prints | more variables, statements and loops |
| instructions | Write lines that follow checkable rules (acrostic, word counts, banned letter…) | 1 → 5 rules at once |
| long-context | Follow a chain of managers through a staff directory | ~2k → ~33k token document |

**The baseline** is every finished run in the first 7 days of tracking, for the same model, effort and question set. Change any of those and a new baseline starts. For a model released before you started tracking it, reports say so and show the baseline date: you can't test the past, so scores are compared with that date, not launch day.

**The verdict** compares the last 3 runs with the baseline. A model is only "worse than baseline" when the whole 95% range of the difference is below zero.

**Also recorded for every question:** thinking tokens, input tokens (the questions never change, so a jump means the provider changed how it counts), cost, refusals, answers cut off early, and which model the API says answered. A small live probe also measures response time.

**Settings are pinned** (model, effort, output limit), so a change in the API's defaults can't look like a nerf. Refusal fallbacks are off, because another model stepping in would mean measuring the wrong model.

## Quick start

Needs Node 24 or later.

```bash
npm install
cp .env.example .env    # then add your Anthropic API key
./nerf generate         # creates your private question set in data/
./nerf submit           # dry run: shows the estimated cost, sends nothing
./nerf submit --yes     # sends the 100 questions through the Batch API (half price)
./nerf collect          # once the batch is done (usually within an hour): grades it and prints a report
./nerf probe --yes      # asks 10 of the questions live and measures response time
./nerf report           # prints the latest report again
```

Every request and answer is saved in `runs/<run id>/`, so you can check the grading yourself.

## Cost

`submit` and `probe` show an estimate and send nothing unless you add `--yes`. On Claude Opus 5 the estimate is about $3 for a batch run of 100 questions and $0.40 for a live probe. How much the model thinks is the biggest factor, so check the first report for the real number. Each report gives the real cost and projects a monthly cost for a run every 2nd day.

Prices live in `src/pricing.ts` (list prices, mid-2026). Update them when they change.

## Keep your questions private

- The generators are public; your seed isn't. `generate` picks a random seed and saves it in `data/questions.json`. Don't publish `data/` or `runs/` (they're gitignored). If your questions leak, they can end up in training data.
- Don't regenerate after your baseline starts. New questions can't be compared with old scores, so `generate` won't overwrite an existing set without `--force`.
- The provider still sees every question you send. That's true of any benchmark run through an API.

## Tune the difficulty first

The first report shows how many questions the model passes at each level. A level it passes 5/5 is too easy and 0/5 is too hard; neither can show a drop. Adjust the difficulty in `src/questions/` (for example `STEPS_BY_LEVEL` in `reasoning.ts`), run `./nerf generate --force`, and only then start your baseline. For a steadier baseline, run more often in the first week, about 10 runs.

## Run it on a schedule

For example, a run every 2nd day with cron:

```
0 6 */2 * *          cd /path/to/nerf-watch && ./nerf submit --yes
0 12 */2 * *         cd /path/to/nerf-watch && ./nerf collect
0 0,6,12,18 */2 * *  cd /path/to/nerf-watch && ./nerf probe --yes
```

## Limitations

- It tests the API, not chat apps like Claude.ai, which add their own instructions and routing. It can't see subscription usage limits.
- A verdict says that a score changed, not why.
- Only Anthropic models for now. Another provider needs its own client (like `src/claude.ts`) and prices in `src/pricing.ts`.

## Project layout

| Path | What's in it |
|---|---|
| `src/questions/` | Question generators and graders, one file per kind |
| `src/claude.ts` | Requests to the Claude API: batches, live probes, results |
| `src/analysis.ts` | Baselines, comparisons and verdicts |
| `src/report.ts` | The plain-text reports |
| `src/cli.ts` | The `./nerf` commands |

## Development

```bash
npm test           # checks every generator and grader; the code questions are verified against real Python
npm run typecheck
```

TypeScript runs directly on Node, with no build step.

Issues and pull requests are welcome. Please don't include question sets or results in them.

## License

MIT
