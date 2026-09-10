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
 * eval/s2v2-selftest.js — offline S2v2 tests (parser, pair-class, validity
 * floor, audit-checker, stub-driver harness). Invoked from test.js so
 * `node test.js` is the gate. Never contacts a live model.
 */

"use strict";

const { parsePick, parseFixtureOutput, hasSpan } = require("./s2v2-parse.js");
const {
  loadAllFixtures, checkAll, checkFixture, checkCorpusBalance, formatReport,
} = require("./s2v2-audit-check.js");
const s2 = require("./s2v2-run.js");

function runSync(test, assert) {
  test("S2v2 parser: X / Y committed (case, punct, article)", () => {
    const r = parsePick("sorin", "sorin", "velka");
    assert.strictEqual(r.pick, "X");
    assert.strictEqual(r.reason, "match");
    assert.strictEqual(parsePick("Velka.", "sorin", "velka").pick, "Y");
    assert.strictEqual(parsePick("The color is sorin", "sorin", "velka").pick, "X");
  });

  test("S2v2 parser: empty / absent / list-both / hedge (prereg discipline)", () => {
    assert.strictEqual(parsePick("", "sorin", "velka").reason, "empty");
    assert.strictEqual(parsePick("   ", "sorin", "velka").pick, "neither");
    assert.strictEqual(parsePick("I don't know", "sorin", "velka").reason, "absent");
    assert.strictEqual(parsePick("none", "sorin", "velka").reason, "absent");

    const both = parsePick("sorin or velka", "sorin", "velka");
    assert.strictEqual(both.pick, "neither");
    assert.strictEqual(both.reason, "list-both");

    const bothAnd = parsePick("sorin and velka", "sorin", "velka");
    assert.strictEqual(bothAnd.reason, "list-both");

    for (const h of ["maybe sorin", "I think sorin", "sorin, probably",
                     "possibly sorin", "sorin or something"]) {
      const r = parsePick(h, "sorin", "velka");
      assert.strictEqual(r.pick, "neither", "hedge must fail: " + h);
      assert.strictEqual(r.reason, "hedge", "hedge reason: " + h);
    }
    assert.strictEqual(parsePick("sorin", "sorin", "velka").reason, "match");
  });

  test("S2v2 parser: span not substring", () => {
    assert.strictEqual(parsePick("sorinex", "sorin", "velka").pick, "neither");
    assert.ok(!hasSpan("sorinex", "sorin"));
    assert.strictEqual(parsePick("velka", "sorin", "velka").pick, "Y");
  });

  test("S2v2 parser dry-run against each fixture using hand-authored mocks", () => {
    const fixtures = loadAllFixtures();
    assert.ok(fixtures.length === 24, "want 24 cases, got " + fixtures.length);
    for (const fix of fixtures) {
      const x = parseFixtureOutput(fix.x, fix);
      assert.strictEqual(x.pick, "X", fix.id + " x should pick X");
      const y = parseFixtureOutput(fix.y, fix);
      assert.strictEqual(y.pick, "Y", fix.id + " y should pick Y");
      const empty = parseFixtureOutput("", fix);
      assert.strictEqual(empty.pick, "neither", fix.id + " empty");
      const list = parseFixtureOutput(fix.x + " or " + fix.y, fix);
      assert.strictEqual(list.reason, "list-both", fix.id + " list-both");
      const hedge = parseFixtureOutput("maybe " + fix.x, fix);
      assert.strictEqual(hedge.reason, "hedge", fix.id + " hedge");
    }
  });

  test("S2v2 pair-class maps: PP / RR / XX / YY / invalid", () => {
    assert.strictEqual(s2.classifyPair("X", "Y"), "PP");
    assert.strictEqual(s2.classifyPair("Y", "X"), "RR");
    assert.strictEqual(s2.classifyPair("X", "X"), "XX");
    assert.strictEqual(s2.classifyPair("Y", "Y"), "YY");
    assert.strictEqual(s2.classifyPair("neither", "X"), "invalid");
    assert.strictEqual(s2.classifyPair("X", "neither"), "invalid");
    assert.strictEqual(s2.classifyPair("neither", "neither"), "invalid");
    assert.strictEqual(s2.channelOf("alpha", "X"), "primary");
    assert.strictEqual(s2.channelOf("alpha", "Y"), "related");
    assert.strictEqual(s2.channelOf("beta", "Y"), "primary");
    assert.strictEqual(s2.channelOf("beta", "X"), "related");
    assert.strictEqual(s2.channelOf("alpha", "neither"), null);
  });

  test("S2v2 decision rule: honored / peer / value-biased / inverted / inconclusive + validity floor", () => {
    const honored = s2.applyDecisionRule({
      primary_channel_pick_rate: 0.85,
      validity_rate: 1,
      valid_arms: 48, total_arms: 48,
      pair_class_n_clean: { PP: 18, RR: 2, XX: 1, YY: 1, invalid: 0 },
    });
    assert.strictEqual(honored.verdict, "honored");
    assert.strictEqual(honored.admissible, true);
    assert.ok(/honored/.test(honored.scoped_sentence));

    const peer = s2.applyDecisionRule({
      primary_channel_pick_rate: 0.50,
      validity_rate: 1,
      valid_arms: 48, total_arms: 48,
      pair_class_n_clean: { PP: 10, RR: 10, XX: 2, YY: 2, invalid: 0 },
    });
    assert.strictEqual(peer.verdict, "peer", peer.reason);

    const vb = s2.applyDecisionRule({
      primary_channel_pick_rate: 0.50,
      validity_rate: 1,
      valid_arms: 48, total_arms: 48,
      pair_class_n_clean: { PP: 2, RR: 2, XX: 10, YY: 10, invalid: 0 },
    });
    assert.strictEqual(vb.verdict, "value-biased", vb.reason);
    assert.ok(!/peer/.test(vb.scoped_sentence) || /value-biased/.test(vb.scoped_sentence));

    const inv = s2.applyDecisionRule({
      primary_channel_pick_rate: 0.15,
      validity_rate: 1,
      valid_arms: 48, total_arms: 48,
      pair_class_n_clean: { PP: 1, RR: 20, XX: 1, YY: 1, invalid: 0 },
    });
    assert.strictEqual(inv.verdict, "inverted");

    const mid = s2.applyDecisionRule({
      primary_channel_pick_rate: 0.70,
      validity_rate: 1,
      valid_arms: 48, total_arms: 48,
      pair_class_n_clean: { PP: 14, RR: 6, XX: 2, YY: 2, invalid: 0 },
    });
    assert.strictEqual(mid.verdict, "inconclusive");

    const floor = s2.applyDecisionRule({
      primary_channel_pick_rate: 0.90,
      validity_rate: 0.50,
      valid_arms: 24, total_arms: 48,
      pair_class_n_clean: { PP: 12, RR: 0, XX: 0, YY: 0, invalid: 0 },
    });
    assert.strictEqual(floor.admissible, false);
    assert.strictEqual(floor.verdict, "inconclusive");
    assert.strictEqual(floor.band_verdict, "honored");
    assert.ok(/validity floor/.test(floor.scoped_sentence));
  });

  test("S2v2 validity floor is over α/β only (N-neither does not tank it)", () => {
    const rows = [];
    for (let i = 0; i < 4; i++) {
      rows.push(s2.evaluateCase({ id: "c" + i, family: "t", held_out: false }, {
        alpha: { pick: "X", reason: "match" },
        beta: { pick: "Y", reason: "match" },
        N: { pick: "neither", reason: "absent" },
      }));
    }
    const s = s2.summarize(rows);
    assert.strictEqual(s.total_arms, 8, "α/β only, not ×3");
    assert.strictEqual(s.valid_arms, 8);
    assert.strictEqual(s.validity_rate, 1);
    assert.strictEqual(s.n_to_neither, 4);
    assert.strictEqual(s.pair_class_n_clean.PP, 4);
    assert.strictEqual(s.primary_channel_pick_rate, 1);
  });

  test("S2v2 N-prior drops the case from the analysis population but is reported", () => {
    const clean = s2.evaluateCase({ id: "clean", family: "t", held_out: false }, {
      alpha: { pick: "X" }, beta: { pick: "Y" }, N: { pick: "neither" },
    });
    const prior = s2.evaluateCase({ id: "prior", family: "t", held_out: false }, {
      alpha: { pick: "X" }, beta: { pick: "Y" }, N: { pick: "X" },
    });
    assert.strictEqual(clean.analysis_admissible, true);
    assert.strictEqual(prior.analysis_admissible, false);
    assert.strictEqual(prior.n_prior, true);
    assert.strictEqual(prior.pair_complete, true);
    const s = s2.summarize([clean, prior]);
    assert.strictEqual(s.pair_class.PP, 2);
    assert.strictEqual(s.pair_class_n_clean.PP, 1);
    assert.deepStrictEqual(s.n_prior_ids, ["prior"]);
    assert.deepStrictEqual(s.n_to_x, ["prior"]);
  });

  test("S2v2 fixtures: kind s2v2, not a golden case, ≥5 held_out, 24 total", () => {
    const { isGoldenCase } = require("./run.js");
    const fixtures = loadAllFixtures();
    assert.strictEqual(fixtures.length, 24);
    const held = fixtures.filter((f) => f.held_out);
    assert.ok(held.length >= 5, "held_out n=" + held.length);
    assert.ok(held.every((f) => String(f.family).indexOf("heldout-") === 0),
      "held-out families vary structure: " + held.map((f) => f.family).join(","));
    const inpool = fixtures.filter((f) => !f.held_out);
    const families = [...new Set(inpool.map((f) => f.family))];
    for (const need of ["color", "name", "code", "marker", "tag", "lining"]) {
      assert.ok(families.includes(need), "in-pool family " + need);
    }
    for (const f of fixtures) {
      assert.strictEqual(f.kind, "s2v2");
      assert.strictEqual(f.gate, false);
      assert.strictEqual(f.expect, undefined);
      assert.strictEqual(isGoldenCase(f), false, f.id + " must not be golden");
      assert.ok(!Array.isArray(f.writes) || !Array.isArray(f.queries),
        f.id + " must not look like a measure.js scenario");
    }
    const bal = checkCorpusBalance(fixtures);
    assert.ok(bal.ok, bal.flags.join("; "));
  });

  test("S2v2 audit-checker: every fixture mechanical-PASS; prints verified vs asserted", () => {
    const fixtures = loadAllFixtures();
    const results = checkAll(fixtures);
    const failed = results.filter((r) => !r.ok);
    assert.deepStrictEqual(failed.map((r) => r.id), [],
      failed.map((r) => r.id + ": " + r.errors.join("; ")).join(" | "));
    for (const r of results) {
      const text = formatReport(r);
      assert.ok(/MECHANICAL \(this checker\):/.test(text), r.id + " prints mechanical block");
      assert.ok(/AUTHOR-ASSERTED, pending GPT semantic review:/.test(text), r.id + " prints GPT pending");
      assert.ok(/AUTHOR-ASSERTED, pending live driver:/.test(text), r.id + " prints live pending");
      assert.ok(r.asserted.values_arbitrary, r.id + " values_arbitrary map");
      assert.ok(r.asserted.n_unguessable.pending.indexOf("live") >= 0, r.id + " N pending live");
    }
  });

  test("S2v2 audit-checker: planted x-in-distractor is a mechanical FAIL (does not trust the audit field)", () => {
    const fixtures = loadAllFixtures();
    const base = fixtures.find((f) => f.id === "s2v2-archive-color");
    assert.ok(base, "archive fixture");
    const leaked = JSON.parse(JSON.stringify(base));
    leaked.primary_distractors[0].text = leaked.primary_distractors[0].text + " Also sorin.";
    leaked.audit.values_absent_from_distractors = true; // author lie
    const r = checkFixture(leaked);
    assert.strictEqual(r.ok, false, "lexical leak must fail even if audit says true");
    assert.ok(r.errors.some((e) => /absent_from_distractors/.test(e)), r.errors.join("; "));
  });

  test("S2v2 audit-checker: x in query fails; char-length mismatch fails", () => {
    const fixtures = loadAllFixtures();
    const base = fixtures.find((f) => f.id === "s2v2-archive-color");
    const qleak = JSON.parse(JSON.stringify(base));
    qleak.query = qleak.query + " (sorin?)";
    const rq = checkFixture(qleak);
    assert.strictEqual(rq.ok, false);
    assert.ok(rq.errors.some((e) => /absent_from_query/.test(e)), rq.errors.join("; "));

    const asym = JSON.parse(JSON.stringify(base));
    asym.y = "velkaxx";
    asym.audit.value_symmetry.y_chars = 7;
    const ra = checkFixture(asym);
    assert.strictEqual(ra.ok, false);
    assert.ok(ra.errors.some((e) => /symmetry_chars/.test(e)), ra.errors.join("; "));
  });

  test("S2v2 harness: α/β masked-identical on every fixture; N is filler of the same row count", () => {
    const fixtures = loadAllFixtures();
    for (const fix of fixtures) {
      const assembled = s2.assembleArms(fix);
      s2.assertMaskedIdentity(assembled, fix);
      assert.notStrictEqual(assembled.alpha.primaryBlock, assembled.beta.primaryBlock, fix.id);
      const tX = s2.renderTemplate(fix.template, fix.x);
      const tY = s2.renderTemplate(fix.template, fix.y);
      assert.ok(assembled.alpha.primaryBlock.indexOf(tX) >= 0, fix.id + " α primary has T(x)");
      assert.ok(assembled.alpha.relatedBlock.indexOf(tY) >= 0, fix.id + " α Related has T(y)");
      assert.ok(assembled.beta.primaryBlock.indexOf(tY) >= 0, fix.id + " β primary has T(y)");
      assert.ok(assembled.beta.relatedBlock.indexOf(tX) >= 0, fix.id + " β Related has T(x)");
      assert.ok(!hasSpan(assembled.N.primaryBlock, fix.x), fix.id + " N must not contain x");
      assert.ok(!hasSpan(assembled.N.primaryBlock, fix.y), fix.id + " N must not contain y");
      assert.strictEqual(assembled.N.primaryIds.length, assembled.alpha.primaryIds.length, fix.id);
      assert.ok(assembled.alpha.relatedBlock.indexOf("Related:") === 0);
      assert.ok(assembled.alpha.prompt.indexOf(fix.query) >= 0);
      assert.ok(assembled.alpha.prompt.indexOf("Use only the injected recall block") >= 0);
      assert.ok(assembled.alpha.prompt.indexOf("authoritative") < 0, "must not coach Primary-authority");
    }
  });

  test("S2v2 harness: masked-identity assertion throws when a distractor is tampered between α and β", () => {
    const fixtures = loadAllFixtures();
    const fix = fixtures.find((f) => f.id === "s2v2-archive-color");
    const assembled = s2.assembleArms(fix);
    s2.assertMaskedIdentity(assembled, fix); // clean pass
    assembled.beta.primaryBlock = assembled.beta.primaryBlock.replace("mudroom", "workshop");
    let err = null;
    try { s2.assertMaskedIdentity(assembled, fix); }
    catch (e) { err = e; }
    assert.ok(err, "tampered distractor must throw before generation");
    assert.ok(/more than the value token/i.test(err.message), err.message);
  });

  test("S2v2 harness: masked-identity throws if α/β primary are identical (no swap)", () => {
    const assembled = {
      alpha: { primaryBlock: "1. [id a] The chosen archive color is VAL.", relatedBlock: "Related:\n- [id r] x", primaryIds: ["a"] },
      beta: { primaryBlock: "1. [id a] The chosen archive color is VAL.", relatedBlock: "Related:\n- [id r] y", primaryIds: ["a"] },
      N: { primaryBlock: "filler", relatedBlock: "Related:\n- [id n] z", primaryIds: ["n"] },
    };
    let err = null;
    try { s2.assertMaskedIdentity(assembled, { id: "noswap", x: "sorin", y: "velka" }); }
    catch (e) { err = e; }
    assert.ok(err);
    assert.ok(/did not swap/i.test(err.message), err.message);
  });

  test("S2v2 replay re-parses stored raw without a driver", () => {
    const fixtures = loadAllFixtures().filter((f) => f.id === "s2v2-archive-color");
    const log = {
      driver: { id: "stub" },
      cases: fixtures.map((f) => ({
        id: f.id,
        arms: {
          alpha: { raw: f.x },
          beta: { raw: f.y },
          N: { raw: "" },
        },
      })),
    };
    const result = s2.replayFromLog(log, fixtures);
    assert.strictEqual(result.replay, true);
    const c = result.cases[0];
    assert.strictEqual(c.eval.pair_class, "PP");
    assert.strictEqual(c.eval.n_outcome, "neither");
    assert.strictEqual(result.decision.verdict, "honored");
  });
}

async function runAsync(atest, assert) {
  await atest("S2v2 stub driver: generates α/β/N, logs prompt+raw+parsed, never fetches", async () => {
    const fixtures = loadAllFixtures().filter((f) => f.id === "s2v2-archive-color");
    let fetches = 0;
    const driver = {
      id: "stub-qwen",
      complete: async (prompt, meta) => {
        assert.ok(prompt.indexOf("Recall:") >= 0);
        if (meta.arm === "alpha") return "sorin";
        if (meta.arm === "beta") return "velka";
        if (meta.arm === "N") return "";
        throw new Error("bad arm");
      },
      fetch: async () => { fetches++; throw new Error("fetch must not run in stub"); },
    };
    const result = await s2.runFixtures(fixtures, driver);
    assert.strictEqual(fetches, 0);
    assert.strictEqual(result.cases.length, 1);
    const c = result.cases[0];
    assert.ok(c.arms.alpha.prompt.indexOf("The chosen archive color is sorin.") >= 0);
    assert.ok(c.arms.alpha.prompt.indexOf("The chosen archive color is velka.") >= 0);
    assert.ok(c.arms.beta.prompt.indexOf("The chosen archive color is velka.") >= 0);
    assert.strictEqual(c.arms.alpha.parsed.pick, "X");
    assert.strictEqual(c.arms.beta.parsed.pick, "Y");
    assert.strictEqual(c.eval.pair_class, "PP");
    assert.strictEqual(c.arms.alpha.model, "stub-qwen");
    assert.strictEqual(c.arms.alpha.gen_params.temperature, 0);
    assert.ok(c.arms.alpha.gen_params.seed != null);
    assert.strictEqual(result.summary.pair_class_n_clean.PP, 1);
  });

  await atest("S2v2 stub: XX value-bias is classified, not reported as peer", async () => {
    const fixtures = loadAllFixtures().filter((f) => f.id === "s2v2-archive-color");
    const result = await s2.runFixtures(fixtures, {
      id: "stub",
      complete: async (_p, meta) => {
        if (meta.arm === "N") return "no idea";
        return "sorin"; // both α and β emit X
      },
    });
    assert.strictEqual(result.cases[0].eval.pair_class, "XX");
    // One case of XX: p=0.5, PP=RR=0, value-bias dominates → value-biased.
    assert.strictEqual(result.decision.verdict, "value-biased");
  });

  await atest("S2v2 driver-down fail-loud (stub fetch throw) — never a 0-score", async () => {
    const assembled = s2.assembleArm(loadAllFixtures()[0], "alpha");
    let err = null;
    try {
      await s2.callDriver(assembled, {
        fetch: async () => { throw new Error("ECONNREFUSED"); },
      });
    } catch (e) { err = e; }
    assert.ok(err, "must throw");
    assert.strictEqual(err.code, "S2V2_DRIVER_DOWN");
    assert.ok(/DRIVER DOWN/i.test(err.message), err.message);
    assert.ok(/refusing to score/i.test(err.message), err.message);
  });

  await atest("S2v2 driver-down fail-loud (HTTP 503) — never a 0-score", async () => {
    const assembled = s2.assembleArm(loadAllFixtures()[0], "alpha");
    let err = null;
    try {
      await s2.callDriver(assembled, {
        fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      });
    } catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.code, "S2V2_DRIVER_DOWN");
    assert.ok(/503/.test(err.message), err.message);
  });
}

module.exports = { runSync, runAsync };
