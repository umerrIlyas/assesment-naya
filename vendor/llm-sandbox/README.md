# LLM sandbox

A local sandbox for our LLM provider's API. The request and response format is the same as the Anthropic Messages API (`POST /v1/messages`).

The vendor supplies it as a prebuilt file. Don't modify it: in production we talk to the real provider, which we don't control.

```bash
npm run llm-sandbox        # listens on http://localhost:4000/v1/messages
```
