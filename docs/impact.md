# How impact is calculated

MemImpact assigns each variant an impact level: `NONE`, `LOW`, `MEDIUM` or `HIGH`.
The level comes from a small set of transparent rules over measurable signals.
There is no hidden model or learned score. Every signal used appears in the
report's **Observed changes** list and in the JSON output under
`variants[].impact`.

> An impact level describes an **observed difference** under your configured
> experiment. It is not proof that the memory *caused* the difference. See
> [Limitations](#limitations).

## Signals

For a variant with baseline runs `B1..Bn` and variant runs `V1..Vn`:

### 1. Word-sequence similarity

Outputs are tokenized into lowercase words. Words are runs of letters and digits.
They can contain inner `.`, `-`, `'`, `+` or `#` and can end in `++` or `#`, so
`Node.js`, `C#` and `C++` stay one token. Two outputs are compared with a Myers
shortest-edit-script diff:

```
similarity(a, b) = 2 × matched words / (words in a + words in b)
```

Two outputs that are identical after normalization have similarity `1`.
Normalization means Unicode NFC, LF line endings, collapsed whitespace, blank
lines removed and lowercased text. Two empty outputs also have similarity `1`.
If two very large outputs need more than 4,000 word insertions or deletions to
turn one into the other, MemImpact switches to a bag-of-words approximation. The report then marks the
similarity as `approximate`.

### 2. Noise floor (needs `repetitions ≥ 2`)

```
crossSimilarity        = mean similarity over all n × n (baseline, variant) pairs
baselineSelfSimilarity = mean pairwise similarity among baseline runs
variantSelfSimilarity  = mean pairwise similarity among variant runs
noiseFloor             = 1 − mean(available self-similarities)
rawDistance            = 1 − crossSimilarity
adjustedDistance       = max(0, rawDistance − noiseFloor)
```

The noise floor estimates how much the outputs differ when nothing is changed.
Subtracting it means that ordinary run-to-run variation does not count as an
effect of the memory. With a single repetition the noise floor is unknown, so
`adjustedDistance = rawDistance`. The report then says that the memory's effect
cannot be separated from run-to-run variation.

### 3. Structured fields

This signal applies only when **every** successful output contains JSON. The
JSON can be the whole output or the first fenced code block, either
` ```json ` or a plain ` ``` ` fence. MemImpact flattens each output into leaf
paths such as `database`, `services[0].name` or `a["odd key"]`. Then it compares
each path's values across all baseline runs and all variant runs:

| Status | Rule |
| --- | --- |
| `unchanged` | Both sides produced the same set of values |
| `changed` | No value is shared between baseline and variant, **and** either each side produced a single value, or one side produced the same value in every one of its runs (2 or more) |
| `added` / `removed` | Like `changed`, but the path is missing on one side in every run |
| `mixed` | The sides share some values but not all, **or** both sides vary from run to run. Either way the difference cannot be separated from run-to-run variation |

The second `mixed` case matters for free-text fields such as a `reason`
string. When a model words it differently on every run, baseline and variant
never share a value, but that is what randomness alone produces. Such a field
is `mixed`, not `changed`.

A field is a **decision field** if it matches a path in `compare.decisionPaths`.
A path matches when it is equal to an entry or nested under it. If
`decisionPaths` is empty, every field counts as a decision field. Paths that
match `compare.ignorePaths` are excluded.

### 4. Tool calls

This signal applies when the runner reports tool calls (OpenAI-compatible
`tool_calls`, command-runner envelopes or fixtures). Each run's tool-call
sequence, with names and arguments in order, becomes a signature. The order
of keys inside arguments is ignored. Signatures are compared with the same
`unchanged` / `changed` / `mixed` rules as fields. A `mixed` tool-call status
is reported as evidence but does not raise the level.

## Classification

Rules are evaluated top to bottom. The first rule that matches sets the level.

| Level | Rule |
| --- | --- |
| **HIGH** | a decision field is `changed`/`added`/`removed`, **or** the tool-call sequence is `changed`, **or** `adjustedDistance ≥ thresholds.high` |
| **MEDIUM** | `adjustedDistance ≥ thresholds.medium`, **or** a non-decision field is `changed`/`added`/`removed` |
| **LOW** | `adjustedDistance ≥ thresholds.low`, **or** any field is `mixed` |
| **NONE** | otherwise |

The default thresholds are `low = 0.05`, `medium = 0.2` and `high = 0.5`. To
change them, set `impact.thresholds`. The values must satisfy
`0 < low < medium < high ≤ 1`.

The defaults are a starting point, not values calibrated against a benchmark.
Tune them for your own outputs. For example, short answers swing more per word
than long ones.

## Evidence basis (attribution)

Every assessment also reports an `attribution` value:

| Value | Meaning |
| --- | --- |
| `no-difference` | Level is NONE and the outputs did not differ meaningfully |
| `within-noise` | The differences are no larger than the variation measured inside each condition. The level is NONE, or LOW when the only signal is a `mixed` field |
| `single-run` | One run per condition, so the effect cannot be separated from run-to-run variation |
| `above-noise` | Multiple runs per condition, and a field or tool-call sequence `changed`, or the noise-adjusted text distance reached the low threshold |

`above-noise` means the difference was larger than the variation seen in
*these* runs. It is not a statistical significance test.

## Example

```
Mean word-sequence similarity 35.3% → raw distance 0.647;
noise floor 0.039 from within-condition self-similarity;
adjusted distance 0.608 (thresholds low 0.05, medium 0.2, high 0.5)
```

`0.608 ≥ 0.5`, so text alone would rate this variant HIGH. It is also HIGH
because the decision field `database` changed from `"PostgreSQL"` to
`"MongoDB"`.

## Limitations

- Similarity is lexical. Two answers that say the same thing in different words
  score as different. Two answers that differ in one crucial word, like *do*
  versus *do not*, can score as similar. Use structured output with
  `decisionPaths` for decisions that matter.
- The noise floor is estimated from a small number of runs. More repetitions
  give a better estimate.
- Arrays in JSON are compared by index, so reordering a list shows up as
  changed fields.
- If `decisionPaths` is empty, every field counts as a decision field. Set
  `decisionPaths` (and `ignorePaths` for free-text fields) for real models.
- Text similarity is computed on the raw output, including JSON fields listed
  in `ignorePaths`. Varying ignored fields therefore raise the noise floor. This
  is conservative, not anti-conservative.
- The causes of a difference are not isolated beyond the single controlled
  memory change. Provider-side changes during the experiment, caching or hidden
  state can also contribute.
