/*
 * Resonance Memory
 * Copyright (C) 2026 Samuel Jackson Grim
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See <https://www.gnu.org/licenses/>.
 */
/*
 * eval/h6-selftest.js — offline H6 tests (parser dry-run, audit-checker,
 * stub-driver harness). Invoked from test.js so `node test.js` is the gate.
 * Never contacts a live model.
 */

"use strict";

const { parseSlot, parseFixtureOutput, hasSpan } = require("./h6-parse.js");
const { loadAllFixtures, checkAll, checkFixture, formatReport } = require("./h6-audit-check.js");
const h6run = require("./h6-run.js");

const COPPER = {
  parser: { type: "exact_slot", canonical: "copper", aliases: [] },
  candidates: ["copper", "saffron"],
};

function runSync(test, assert) {
  sectioned(test, assert);
}

function sectioned(test, assert) {
  test("H6 parser: correct (canonical, case, punct, article)", () => {
    assert.strictEqual(parseSlot("copper", COPPER.parser, COPPER.candidates).ok, true);
    assert.strictEqual(parseSlot("Copper.", COPPER.parser, COPPER.candidates).ok, true);
    assert.strictEqual(parseSlot("The color is copper", COPPER.parser, COPPER.candidates).ok, true);
    assert.strictEqual(parseSlot("copper!", COPPER.parser, COPPER.candidates).reason, "match");
  });

  test("H6 parser: wrong / hedge / list-everything / empty (prereg discipline)", () => {
    const wrong = parseSlot("saffron", COPPER.parser, COPPER.candidates);
    assert.strictEqual(wrong.ok, false);
    assert.strictEqual(wrong.reason, "wrong");

    const hedge = parseSlot("I'm not sure", COPPER.parser, COPPER.candidates);
    assert.strictEqual(hedge.ok, false);
    assert.ok(hedge.reason === "absent" || hedge.reason === "empty");

    // GPT audit ruling (strict): a present+unique gold span that is not
    // COMMITTED fails. "maybe copper" surfaces the value without committing.
    for (const h of ["maybe copper", "I think copper", "copper, probably",
                     "possibly copper", "copper or something"]) {
      const r = parseSlot(h, COPPER.parser, COPPER.candidates);
      assert.strictEqual(r.ok, false, "hedge must fail: " + h);
      assert.strictEqual(r.reason, "hedge", "hedge reason: " + h);
    }
    // A bare committed value with no hedge token still passes.
    assert.strictEqual(parseSlot("copper", COPPER.parser, COPPER.candidates).reason, "match");

    const list = parseSlot("copper or saffron", COPPER.parser, COPPER.candidates);
    assert.strictEqual(list.ok, false);
    assert.strictEqual(list.reason, "list-everything");

    const empty = parseSlot("", COPPER.parser, COPPER.candidates);
    assert.strictEqual(empty.ok, false);
    assert.strictEqual(empty.reason, "empty");

    const blank = parseSlot("   ", COPPER.parser, COPPER.candidates);
    assert.strictEqual(blank.ok, false);
  });

  test("H6 parser: span not substring (614 vs 2614; wren vs wrench)", () => {
    const p = { type: "exact_slot", canonical: "614", aliases: [] };
    const cand = ["614", "271"];
    assert.strictEqual(parseSlot("614", p, cand).ok, true);
    assert.strictEqual(parseSlot("the code is 2614", p, cand).ok, false);
    assert.strictEqual(parseSlot("271", p, cand).reason, "wrong");

    const w = { type: "exact_slot", canonical: "wren", aliases: [] };
    assert.strictEqual(parseSlot("wren", w, ["wren", "pike"]).ok, true);
    assert.strictEqual(parseSlot("wrench", w, ["wren", "pike"]).ok, false);
    assert.ok(!hasSpan("wrench", "wren"));
  });

  test("H6 parser: alias hits; competing alias of gold is not list-everything", () => {
    const p = { type: "exact_slot", canonical: "614", aliases: ["six one four"] };
    const cand = ["614", "271", "six one four"];
    assert.strictEqual(parseSlot("six one four", p, cand).ok, true);
    assert.strictEqual(parseSlot("614 (six one four)", p, cand).ok, true, "gold + its alias is still one value");
    assert.strictEqual(parseSlot("six one four or 271", p, cand).reason, "list-everything");
  });

  test("H6 parser dry-run against each S1 gold using hand-authored mocks", () => {
    const fixtures = loadAllFixtures();
    assert.ok(fixtures.length >= 12, "S1+S2 fixtures present, got " + fixtures.length);
    for (const fix of fixtures) {
      const gold = parseFixtureOutput(fix.parser.canonical, fix);
      assert.strictEqual(gold.ok, true, fix.id + " canonical should match");
      const empty = parseFixtureOutput("", fix);
      assert.strictEqual(empty.ok, false, fix.id + " empty");
      const hedge = parseFixtureOutput("I don't know", fix);
      assert.strictEqual(hedge.ok, false, fix.id + " hedge");
      if (fix.alt && fix.alt.value) {
        const wrong = parseFixtureOutput(String(fix.alt.value), fix);
        assert.strictEqual(wrong.ok, false, fix.id + " alt must not credit");
        const list = parseFixtureOutput(fix.parser.canonical + " or " + fix.alt.value, fix);
        assert.strictEqual(list.ok, false, fix.id + " list-everything");
        assert.strictEqual(list.reason, "list-everything");
      }
    }
  });

  test("H6 fixtures: no expect, kind h6, not a golden case", () => {
    const { isGoldenCase } = require("./run.js");
    const fixtures = loadAllFixtures();
    const s1 = fixtures.filter((f) => f.stratum === "related-necessary");
    const s2 = fixtures.filter((f) => f.stratum === "primary-sufficient");
    assert.ok(s1.length >= 7, "S1 n=" + s1.length);
    assert.ok(s2.length >= 7, "S2 n=" + s2.length);
    const families = [...new Set(s1.filter((f) => !f.held_out).map((f) => f.family))];
    for (const need of ["A", "B", "C", "D", "E"]) {
      assert.ok(families.includes(need), "in-pool family " + need);
    }
    assert.ok(s1.some((f) => f.held_out), "held-out S1 present");
    const heldFamilies = [...new Set(s1.filter((f) => f.held_out).map((f) => f.family))];
    assert.ok(heldFamilies.every((hf) => String(hf).indexOf("heldout-") === 0),
      "held-out varies structure (not A–E with new values): " + heldFamilies.join(","));
    assert.ok(s1.some((f) => f.held_out && f.family === "heldout-callsign"));
    assert.ok(s1.some((f) => f.held_out && f.family === "heldout-tab"));
    for (const f of fixtures) {
      assert.strictEqual(f.kind, "h6");
      assert.strictEqual(f.gate, false);
      assert.strictEqual(f.expect, undefined);
      assert.strictEqual(isGoldenCase(f), false, f.id + " must not be golden");
      assert.ok(!Array.isArray(f.writes) || !Array.isArray(f.queries),
        f.id + " must not look like a measure.js scenario");
    }
  });

  test("H6 audit-checker: every fixture mechanical-PASS; prints verified vs asserted", () => {
    const fixtures = loadAllFixtures();
    const results = checkAll(fixtures);
    const failed = results.filter((r) => !r.ok);
    assert.deepStrictEqual(failed.map((r) => r.id), [], failed.map((r) => r.id + ": " + r.errors.join("; ")).join(" | "));
    for (const r of results) {
      const text = formatReport(r);
      assert.ok(/MECHANICAL \(this checker\):/.test(text), r.id + " prints mechanical block");
      assert.ok(/AUTHOR-ASSERTED, pending GPT semantic review:/.test(text), r.id + " prints GPT pending");
      assert.ok(/AUTHOR-ASSERTED, pending live driver:/.test(text), r.id + " prints live pending");
      assert.ok(r.mechanical.C1_exact_lexical && r.mechanical.C1_exact_lexical.ok, r.id + " C1");
      assert.ok(r.asserted.C2_semantic_equivalent, r.id + " C2 asserted map");
      assert.ok(r.asserted.C5_no_recall.pending.indexOf("live") >= 0, r.id + " C5 pending live");
    }
  });

  test("H6 audit-checker: planted C1 leak is a mechanical FAIL (does not trust the audit field)", () => {
    const fixtures = loadAllFixtures();
    const base = fixtures.find((f) => f.id === "h6-s1-copper-labels");
    assert.ok(base, "copper fixture");
    const leaked = JSON.parse(JSON.stringify(base));
    leaked.primary[0].text = leaked.primary[0].text + " The assigned color is copper.";
    leaked.audit.exact_lexical = "pass"; // author lie
    const r = checkFixture(leaked);
    assert.strictEqual(r.ok, false, "joint/lexical leak must fail even if audit says pass");
    assert.ok(r.errors.some((e) => /C1/.test(e)), r.errors.join("; "));
  });

  test("H6 audit-checker: B filler containing gold fails", () => {
    const fixtures = loadAllFixtures();
    const base = fixtures.find((f) => f.id === "h6-s1-copper-labels");
    const bad = JSON.parse(JSON.stringify(base));
    bad.filler.text = "A note says the hallway was dusted with copper polish last Thursday.";
    const r = checkFixture(bad);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => /filler/i.test(e)), r.errors.join("; "));
  });

  test("H6 harness: A/B/D primary IDs+order byte-identical; N is replaced", () => {
    const fixtures = loadAllFixtures();
    for (const fix of fixtures) {
      const assembled = h6run.assembleArms(fix);
      const block = h6run.assertPrimaryIdentity(assembled, fix);
      assert.ok(block.length > 0, fix.id);
      assert.strictEqual(assembled.A.primaryBlock, assembled.B.primaryBlock);
      assert.strictEqual(assembled.A.primaryBlock, assembled.D.primaryBlock);
      assert.notStrictEqual(assembled.N.primaryBlock, assembled.A.primaryBlock,
        fix.id + " N must replace primary");
      assert.ok(assembled.A.relatedBlock.indexOf("Related:") === 0);
      assert.ok(assembled.B.relatedBlock.indexOf("Related:") === 0);
      assert.ok(assembled.A.user.indexOf("Recall:") >= 0);
      assert.ok(assembled.A.prompt.indexOf(fix.query) >= 0);
      // B filler is not a skip-cue and is not the gold sentence
      assert.ok(assembled.B.relatedBlock.indexOf(fix.parser.canonical) < 0
        || !hasSpan(assembled.B.relatedBlock, fix.parser.canonical));
    }
  });

  test("H6 harness: primary-identity assertion throws on mismatch", () => {
    const assembled = {
      A: { primaryBlock: "1. [id memory-03] aaa", primaryIds: ["memory-03"] },
      B: { primaryBlock: "1. [id memory-99] aaa", primaryIds: ["memory-99"] },
      D: { primaryBlock: "1. [id memory-03] aaa", primaryIds: ["memory-03"] },
    };
    let err = null;
    try { h6run.assertPrimaryIdentity(assembled, { id: "tamper", primary_ids: ["memory-03"] }); }
    catch (e) { err = e; }
    assert.ok(err, "mismatch must throw before generation");
    assert.ok(/byte-identical|IDs\/order/i.test(err.message), err.message);
  });

  test("H6 scoring: S1 B→A win; S1 B-succeeds dropped; S2 B-succeeds kept; N-pass dropped; S2 A→D hijack", () => {
    const s1 = {
      id: "t-s1", stratum: "related-necessary", family: "A", held_out: false,
    };
    const s2 = {
      id: "t-s2", stratum: "primary-sufficient", family: "A", held_out: false,
    };
    const win = h6run.evaluateCase(s1, {
      A: { ok: true }, B: { ok: false }, D: { ok: false }, N: { ok: false },
    });
    assert.strictEqual(win.valid, true);
    assert.strictEqual(win.b_to_a, true);
    assert.strictEqual(win.a_to_b, false);

    const leak = h6run.evaluateCase(s1, {
      A: { ok: true }, B: { ok: true }, D: { ok: false }, N: { ok: false },
    });
    assert.strictEqual(leak.valid, false);
    assert.strictEqual(leak.drop_b_succeeds, true);

    const npass = h6run.evaluateCase(s1, {
      A: { ok: true }, B: { ok: false }, D: { ok: false }, N: { ok: true },
    });
    assert.strictEqual(npass.valid, false);
    assert.strictEqual(npass.drop_n_pass, true);

    const s2ok = h6run.evaluateCase(s2, {
      A: { ok: true }, B: { ok: true }, D: { ok: true }, N: { ok: false },
    });
    assert.strictEqual(s2ok.valid, true, "S2 B-succeeds is expected (primary sufficient)");
    assert.strictEqual(s2ok.drop_b_succeeds, false);
    assert.strictEqual(s2ok.a_to_d, false);

    const hijack = h6run.evaluateCase(s2, {
      A: { ok: true }, B: { ok: true }, D: { ok: false }, N: { ok: false },
    });
    assert.strictEqual(hijack.a_to_d, true);
    assert.strictEqual(hijack.valid, true);

    const hurt = h6run.evaluateCase(s1, {
      A: { ok: false }, B: { ok: true }, D: { ok: false }, N: { ok: false },
    });
    assert.strictEqual(hurt.a_to_b, true, "A wrong / B correct is the other off-diagonal");
    assert.strictEqual(hurt.drop_b_succeeds, true, "B-succeeds still drops S1 before scoring");
  });

  test("H6 replay re-parses stored raw without a driver", () => {
    const fixtures = loadAllFixtures().filter((f) => f.id === "h6-s1-copper-labels"
      || f.id === "h6-s2-copper-labels");
    const log = {
      driver: { id: "stub" },
      cases: fixtures.map((f) => ({
        id: f.id,
        arms: {
          A: { raw: f.parser.canonical },
          B: { raw: f.stratum === "primary-sufficient" ? f.parser.canonical : "I don't know" },
          D: { raw: String(f.alt.value) },
          N: { raw: "" },
        },
      })),
    };
    const result = h6run.replayFromLog(log, fixtures);
    assert.strictEqual(result.replay, true);
    const s1 = result.cases.find((c) => c.id === "h6-s1-copper-labels");
    assert.strictEqual(s1.eval.b_to_a, true);
    assert.strictEqual(s1.eval.valid, true);
    const s2 = result.cases.find((c) => c.id === "h6-s2-copper-labels");
    assert.strictEqual(s2.eval.a_to_d, true);
  });
}

async function runAsync(atest, assert) {
  await atest("H6 stub driver: generates A/B/D/N, logs prompt+raw+parsed, never fetches", async () => {
    const fixtures = loadAllFixtures().filter((f) => f.id === "h6-s1-copper-labels");
    let fetches = 0;
    const driver = {
      id: "stub-qwen",
      complete: async (prompt, meta) => {
        assert.ok(prompt.indexOf("Recall:") >= 0);
        if (meta.arm === "A") return "copper";
        if (meta.arm === "B") return "I don't know";
        if (meta.arm === "D") return "saffron";
        if (meta.arm === "N") return "";
        throw new Error("bad arm");
      },
      fetch: async () => { fetches++; throw new Error("fetch must not run in stub"); },
    };
    const result = await h6run.runFixtures(fixtures, driver);
    assert.strictEqual(fetches, 0);
    assert.strictEqual(result.cases.length, 1);
    const c = result.cases[0];
    assert.ok(c.arms.A.prompt.indexOf("copper for labels") >= 0);
    assert.ok(c.arms.B.prompt.indexOf("hallway shelf was dusted") >= 0);
    assert.strictEqual(c.arms.A.parsed.ok, true);
    assert.strictEqual(c.arms.B.parsed.ok, false);
    assert.strictEqual(c.eval.b_to_a, true);
    assert.strictEqual(c.arms.A.model, "stub-qwen");
    assert.strictEqual(c.arms.A.gen_params.temperature, 0);
    assert.ok(c.arms.A.gen_params.seed != null);
  });

  await atest("H6 driver-down fail-loud (stub fetch throw) — never a 0-score", async () => {
    const assembled = h6run.assembleArm(loadAllFixtures()[0], "A");
    let err = null;
    try {
      await h6run.callDriver(assembled, {
        fetch: async () => { throw new Error("ECONNREFUSED"); },
      });
    } catch (e) { err = e; }
    assert.ok(err, "must throw");
    assert.strictEqual(err.code, "H6_DRIVER_DOWN");
    assert.ok(/DRIVER DOWN/i.test(err.message), err.message);
    assert.ok(/refusing to score/i.test(err.message), err.message);
  });

  await atest("H6 driver-down fail-loud (HTTP 503) — never a 0-score", async () => {
    const assembled = h6run.assembleArm(loadAllFixtures()[0], "A");
    let err = null;
    try {
      await h6run.callDriver(assembled, {
        fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      });
    } catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.code, "H6_DRIVER_DOWN");
    assert.ok(/503/.test(err.message), err.message);
  });
}

module.exports = { runSync, runAsync, COPPER };
