## task

You are given several drafts of the same scene, as a JSON array of strings. Pick the best one.

Judge on the prose, not the plot: the drafts share a plot. Reward specificity, restraint, and a line of dialogue that does two things at once. Penalise adjectives doing a verb's job, and any sentence that explains what the previous sentence already showed.

## output

Reply with JSON and nothing else — no prose around it, no code fence:

```
{ "winner": <the zero-based index of the draft you chose>, "rationale": "<one or two sentences>" }
```

The rationale is for the writer, not for the record: name the specific thing the winning draft did that the others did not.
