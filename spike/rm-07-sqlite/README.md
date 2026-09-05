# RM-07 spike — `node:sqlite` + vector path (not product)

Feasibility spike for [`docs/proposed/0010-sqlite-backend.md`](../../docs/proposed/0010-sqlite-backend.md).
**Do not require these files from `server.js` / `memory-core.js` / `eval/pipeline.js`.**

```
node spike/rm-07-sqlite/run.js
node spike/rm-07-sqlite/run.js --skip-sea --n 10000,50000
```

Needs the S1 vector cache at `eval/substrate/.cache/` (already filled on this box).
Writes `results.json` + `results.md`. Vendor binaries (`sqlite-vec` `.dll`) and
scratch DBs stay gitignored under `vendor/` and `tmp/`.

```
node spike/rm-07-sqlite/measure-cached.js      # RAM-cache recall at 10k/50k/100k
node spike/rm-07-sqlite/measure-vec-100k.js    # sqlite-vec MATCH at 100k
```

Design RFC: [`docs/proposed/0010-sqlite-backend.md`](../../docs/proposed/0010-sqlite-backend.md).
