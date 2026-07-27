# Resonance Memory

**A lasting memory for your local AI — one that actually remembers you, and never leaves your machine.**

Your local model is smart, but it has amnesia. Close the chat and it forgets everything: your
name, your preferences, the decision you explained twice yesterday. Resonance Memory fixes that.
It gives your AI a memory that survives across conversations — stored on your computer, tied to
no account, sent to no cloud.

And it's not a search box you have to operate. It's more like giving your AI a *brain* — it
quietly remembers what matters and brings the right things back on its own.

---

## Why you'd want this

If you run a local model (in LM Studio, Claude Desktop, anything that speaks MCP), you already
know the pain: every conversation starts from zero. You re-explain who you are, what you're
working on, how you like things done. Forever.

With Resonance Memory, you say something once, and weeks later — in a totally different chat —
it's still there. No re-explaining. No copy-pasting yesterday's context back in. Your AI just
*knows*.

## What you can actually use it for

Real things, not buzzwords:

- **It remembers your rules.** Tell it once, *"I'm diabetic, keep sugar out of any recipe you
  suggest."* Ten conversations later you ask for a dessert — and it remembers, without you
  saying it again.
- **It's a project logbook that thinks.** *"We went with the simpler option because the file
  has to stay human-readable."* Next week: *"wait, why didn't we use a database?"* — and it
  gives you the real reason, in your own words, not a guess.
- **It finds things by meaning, not keywords.** You saved *"the dog needs his heartworm pill on
  the 1st."* Months later you ask, *"what was that pet medication thing?"* — no shared words, and
  it still finds it.
- **It connects the dots you didn't.** Turn on the associative field and it starts noticing which
  of your memories belong together — surfacing related things you didn't think to ask for.

## Get started (about 60 seconds)

1. **Double-click `resonance-memory.exe`.** A page opens in your browser. *(No window pops up —
   that's on purpose.)*
2. On that page, click **Connect** next to your app (LM Studio or Claude Desktop).
3. **Restart that app once** so it picks up the memory.

Done. Your AI can now save and recall memories on its own.

Want to see what it does *before* connecting anything? Click **Show demo graph** on that page —
it draws a little constellation of example memories so you can watch how related ideas cluster
together and link up.

## How it works (the plain version)

Under the hood it's refreshingly simple:

- Your AI gets four abilities — **save**, **recall**, **edit**, **delete**. That's the whole
  interface, and it never gets more complicated than that.
- When you tell it something worth keeping, it stores a *fingerprint of the meaning* (not just
  the words). That fingerprint is made by your own local model — so, again, **nothing leaves
  your computer.**
- Later, when something's relevant, it finds it by *meaning*. That's why "pet medication thing"
  can find a note about a heartworm pill.
- Flip on the **associative field** and it starts learning which memories go together as you use
  it — the same "things that fire together, wire together" idea your actual brain runs on. The
  graph in the app is that, made visible.

The clever stuff lives *inside*, so your AI never has to think harder — it just gets a better
memory.

## Good to know

- **"Windows protected your PC" on first launch?** That's SmartScreen being cautious about any
  new program that isn't signed by a big company (code-signing certificates cost money). Click
  **More info → Run anyway**. The whole thing is open source — you can read every line.
- **Is my data private?** Completely. Everything — your memories, the fingerprints, the graph —
  stays in a file on your machine, under your user folder. No servers, no telemetry, no account.
- **How do I turn the extra smarts off?** The **associative field** has a switch in the app.
  Off by default; flip it whenever. The memory itself works either way.
- **How do I remove it?** Double-click `uninstall.bat`. It disconnects from your apps and tells
  you where your memory file is (it will **not** delete your memories unless you do). Then delete
  the folder.
- **A note on saving:** your AI decides when to save and recall on its own, nudged by how the
  tools are described to it. Smaller models sometimes need a reminder — a simple *"remember
  this"* or *"check your memory"* always works. There's an optional `system-prompt.md` in this
  folder that makes weaker models do it more reliably.

## Support the Architect

This is free, and it stays free. If it earns a place in how you work, a coffee keeps it getting
better — there are **Ko-fi** and **PayPal** links right in the app.

## For the curious (and for developers)

Nothing here is a black box. The memory model, the association rules, and the local-first
principles it's built on are written down in **`DEVELOPERS.md`** and in the architecture spec at
[resonance-memory-stack](https://github.com/SamuelJacksonGrim/resonance-memory-stack). Build from
source with `node build-exe.js`.

## License

GPL-3.0. Use it, fork it, build on it — just keep your version open too.

---

*Made by the Architect of Resonance.*
