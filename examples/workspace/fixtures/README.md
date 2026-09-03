# fixtures

Mock provider scripts (spec/model-layer.md §Mock provider). One JSON object per file, tried in filename order; the first whose `match` conditions all hold answers the call. With no match the mock echoes the last user text.

```jsonc
{ "match":   { "modelId": "google/*", "systemIncludes": "…", "lastUserIncludes": "…", "callIndex": 2 },
  "respond": { "text": "…", "error": "RateLimit", "finishReason": "stop", "latencyMs": 50, "usage": { "input": 10, "output": 5 } } }
```
