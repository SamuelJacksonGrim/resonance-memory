# itch.io page copy (source of truth for https://samueljacksongrim.itch.io/resonance-memory)

itch.io does not update from GitHub (neither the README nor the landing page), so its text lives here. When a release
changes what the app does, edit this file in the same PR; the release kit on the Desktop gets a paste-ready copy.

## Uploads

Delete the old `resonance-memory.exe` upload, then upload these three from the GitHub Release,
each with its platform ticked:

| File | Tick |
|---|---|
| `resonance-memory.exe` | Windows |
| `resonance-memory-macos-arm64` | macOS |
| `resonance-memory-linux-x64` | Linux |

(`SHA256SUMS` doesn't need uploading; it's on the GitHub release.)

## Short description / tagline

Your AI takes notes. This builds the mind. A lasting, private memory for your local AI.

---

## Description (paste into the "Description" box)

**Your AI takes notes. This builds the mind.**

Your local model is smart, but it has amnesia. Close the chat and it forgets everything: your **name**, your
**preferences**, the decision you explained twice yesterday. **Resonance Memory** gives it a memory that **survives
across conversations**, stored on **your computer, tied to no account, sent to no cloud.**

And it's **not a search box** you operate. It **quietly remembers** what matters and brings the right things back on its
own, then starts noticing which of your memories belong together, the way your own brain links things that come up
as a set. **That's the difference between a notebook and a memory.**

**WHAT YOU CAN USE IT FOR**

- **Remembers your rules.** Tell it once (*"I'm diabetic, keep sugar out of any recipe"*) and it still holds ten
  conversations later.
- **A project logbook that thinks.** The WHY behind your decisions, in your own words.
- **Finds things by meaning.** *"What was that pet medication thing?"* finds your note about the dog's heartworm pill,
  with no shared keywords.
- **Keeps up when things change.** Say "I moved to Denver" and the old city is retired, not contradicted.
- **Connects the dots you didn't.** Surfaces related memories you never thought to ask for, and strengthens the links
  you actually use.

**NEW IN 0.3: THE WHOLE MEMORY SYSTEM**

The memory system we built and run every day with Claude now ships inside the app, exactly as it runs: plain folders
and files on your computer.

- **Who you are stays on top.** How you want to be treated and how you work together are never filed away.
- **Everything else is filed** into subject drawers, each with its own index card. Replaced facts fade into a dated
  history instead of being lost.
- **Recall on every message.** Each message you send surfaces the memories that match it, so the AI never has to
  remember to look.
- **Keeps itself current.** Every memory write updates the recall index in the background.

**One click in the app sets it up for Claude Code**, and any other AI agent can be pointed at the same folder.

**PRIVATE AND YOURS**

Everything lives on **your computer**, under your user folder. No servers, no telemetry, no account. **Export my
memories** writes a `.zip` you own, including a plain file any other tool can read; **Import** brings it back on any
machine. **Open source (AGPL-3.0).**

**WHAT YOU NEED**

An AI app that speaks **MCP**: **LM Studio** or **Claude Desktop** (one-click connect), or **Claude Code, Cursor,
Continue, Hermes** and others (copy-paste setup from the app). For meaning-based recall, LM Studio with a small
embedding model. **The app sets that up in one click.**

Guides and source: github.com/SamuelJacksonGrim/resonance-memory

Free, and it stays free. If it earns a place in how you work, there's a Ko-fi link right in the app.

Made by the *Architect of Resonance.*

---

## Install instructions (paste into the "Install instructions" box)

**Windows, macOS and Linux.** One file, no installer.

**Windows**
1. Download `resonance-memory.exe` and double-click it. A page opens in your browser; no window pops up,
   that's normal.
2. First launch may show "Windows protected your PC" (SmartScreen, because the app isn't signed by a big company).
   Click **More info → Run anyway.** It's open source: you can read every line.

**macOS (Apple Silicon)**
1. Download `resonance-memory-macos-arm64`. Don't double-click it (Gatekeeper blocks downloaded copies): right-click →
   **Open** → **Open**, or System Settings → Privacy & Security → **Open Anyway**.
2. Or in Terminal: `xattr -d com.apple.quarantine resonance-memory-macos-arm64`, then `chmod +x` and run it.

**Linux (x64)**
1. `chmod +x resonance-memory-linux-x64 && ./resonance-memory-linux-x64`. A page opens in your browser.

**Then (every platform)**
3. On that page, click **Connect** next to your app (LM Studio or Claude Desktop), then **restart that app once.**
   Using Claude Code, Cursor or another MCP app? Copy the setup snippet from the same page.
4. If "Meaning engine" says "not set up," click **Set up**: one click grabs a small helper model in LM Studio so recall
   works by **meaning**, not just exact words.

**Everything stays on your computer.** To remove it: click **Disconnect** in the app, then delete the file. Your
memories stay in your user folder until you delete them yourself.

