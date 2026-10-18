# Privacy: Resonance Memory plugin

Last updated 2026-10-18.

**Resonance Memory collects nothing.** It has no servers, no telemetry, no analytics and no accounts. The author
receives no data of any kind from your use of it.

What happens on your own computer:

- **Your memories** are markdown files in your memory folder (by default, the memory folder Claude Code keeps for each
  project). The plugin reads them to find the ones that match your message. On first run in a folder it adds starter
  files that don't already exist. It never edits, moves or deletes your files; Claude does that in conversation, by
  the rules in `memory-architecture.md`, where you can see it.
- **Your messages** are read by the per-message hook to compare against your memories, on your machine, and are not
  stored by the plugin.
- **The recall index** (numbers representing your memories, plus a keyword index) is a cache in Claude Code's plugin
  data folder. Uninstalling the plugin deletes it. Your memories stay.
- **Embedding**, if you run LM Studio or Ollama, sends memory text and message text to that server at `127.0.0.1`
  (your own computer). If you point the plugin at a different embedder endpoint yourself, text goes to that endpoint,
  under that service's own terms. With no embedder, nothing is sent anywhere.

Questions: samgrim97@gmail.com, or an issue at https://github.com/SamuelJacksonGrim/resonance-memory.
