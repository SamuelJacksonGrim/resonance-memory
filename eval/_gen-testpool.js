#!/usr/bin/env node
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
 * Authoring helper for the activation test-pool fixtures.
 *   node eval/_gen-testpool.js
 * measure.js reads the committed jsonl, not this file. Re-run after
 * editing the case lists, then commit the jsonl diff.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "corpora");

function W(id, role, text) { return { id, role, text }; }

const DIABETIC_HOSTILE = [
  W("apex", "apex", "I'm diabetic, so no sugary desserts for me"),
  W("bridge", "bridge", "I always bring lemon bars to the office dessert potluck"),
  W("hub-standup", "hub", "The Friday standup moved to 3pm"),
  W("hub-table", "hub", "I need to bring a folding table for the potluck"),
  W("hub-signup", "hub", "The potluck signup sheet is on the office fridge"),
  W("hub-parking", "hub", "Parking is tight at the office on Fridays"),
  W("hub-room", "hub", "Someone booked the big conference room for Friday"),
  W("hub-kitchen", "hub", "The potluck is in the fourth-floor kitchen"),
  W("hub-carpool", "hub", "I carpool with Dana on Fridays"),
  W("hub-casual", "hub", "Fridays are casual dress at the office"),
  W("hub-coffee", "hub", "The office coffee machine broke again"),
  W("hub-dentist", "hub", "I have a dentist appointment Friday morning"),
  W("hub-review", "hub", "The quarterly review is next Friday"),
  W("hub-chairs", "hub", "We're short on chairs for the potluck"),
  W("hub-printer", "hub", "The office printer is out of toner"),
  W("hub-chili", "hub", "I'm bringing my three-bean chili to the potluck"),
  W("hub-veggie", "hub", "Someone always brings the veggie tray to potlucks"),
  W("hub-savory", "hub", "The potluck needs more savory dishes this time"),
  W("hub-marcus", "hub", "Marcus is organizing the Friday potluck"),
  W("hub-popcorn", "hub", "The break room smells like burnt popcorn"),
  W("hub-lunch", "hub", "Our team lunch is usually on Fridays"),
  W("hub-badge", "hub", "I left my badge at home last Friday"),
  W("hub-elevator", "hub", "The elevator is slow during the Friday rush"),
  W("hub-email", "hub", "There is a food sign-up email going around for Friday"),
  W("ctrl-cat", "control", "My cat is named Koneko"),
  W("ctrl-apt", "control", "I live in a small apartment"),
  W("ctrl-tea", "control", "I prefer tea over coffee"),
];

const DIABETIC_FRIENDLY = [
  W("apex", "apex", "I'm diabetic, so no sugary desserts for me"),
  W("bridge", "bridge", "I always bring lemon bars to the office dessert potluck"),
  W("ctrl-cat", "control", "My cat is named Koneko"),
  W("ctrl-apt", "control", "I live in a small apartment"),
  W("ctrl-tea", "control", "I prefer tea over coffee"),
  W("ctrl-job", "control", "I work as a software architect"),
  W("ctrl-night", "control", "I usually code late at night"),
  W("ctrl-color", "control", "My favorite color is deep blue"),
  W("ctrl-wake", "control", "I usually wake up at six"),
  W("ctrl-rent", "control", "The rent is due on the first"),
  W("ctrl-plant", "control", "I keep a plant on the windowsill"),
  W("ctrl-bus", "control", "I take the bus to work"),
  W("ctrl-read", "control", "I read before bed most nights"),
  W("ctrl-black", "control", "I drink my coffee black"),
  W("ctrl-window", "control", "I prefer window seats on flights"),
  W("ctrl-silent", "control", "My phone is always on silent"),
  W("ctrl-neighbor", "control", "My neighbor plays loud music"),
  W("ctrl-laundry", "control", "The laundry room is in the basement"),
];

const VEG_HOSTILE = [
  W("apex", "apex", "I'm vegetarian, so no meat dishes for me"),
  W("bridge", "bridge", "My wild mushroom risotto always wins at team dinners"),
  W("hub-time", "hub", "The team dinner is at 7pm Saturday"),
  W("hub-room", "hub", "I booked the private room for the dinner"),
  W("hub-bill", "hub", "Everyone is splitting the bill evenly"),
  W("hub-wine", "hub", "Marcus is bringing the wine"),
  W("hub-steak", "hub", "The steakhouse downtown takes reservations"),
  W("hub-roast", "hub", "My pot roast needs four hours in the oven"),
  W("hub-ribeye", "hub", "I grill ribeye with a peppercorn crust"),
  W("hub-brisket", "hub", "The barbecue brisket smokes all day"),
  W("hub-chicken", "hub", "Roast chicken is my go-to for guests"),
  W("hub-twelve", "hub", "Twelve people are coming to the dinner"),
  W("hub-bread", "hub", "The garlic bread goes in at the end"),
  W("hub-chili", "hub", "My chili has three kinds of beans"),
  W("hub-lasagna", "hub", "I make a big lasagna for crowds"),
  W("hub-caesar", "hub", "The caesar salad needs fresh croutons"),
  W("hub-water", "hub", "Someone should bring sparkling water"),
  W("hub-playlist", "hub", "The dinner playlist is already made"),
  W("hub-office", "hub", "We are meeting at the office first"),
  W("hub-name", "hub", "The reservation is under my last name"),
];

const HEIGHTS_HOSTILE = [
  W("apex", "apex", "I'm terrified of heights"),
  W("bridge", "bridge", "The rooftop bar downtown has the best cocktails"),
  W("hub-hh", "hub", "The Friday happy hour starts at six"),
  W("hub-new", "hub", "That new cocktail bar just opened downtown"),
  W("hub-pub", "hub", "We usually meet at the pub on Fridays"),
  W("hub-wine", "hub", "The wine bar has a good happy hour"),
  W("hub-parking", "hub", "Parking downtown is brutal on Friday nights"),
  W("hub-brewery", "hub", "The brewery has live music on Fridays"),
  W("hub-speak", "hub", "I like the speakeasy on Third Street"),
  W("hub-uber", "hub", "Uber surge pricing hits after midnight"),
  W("hub-sports", "hub", "The sports bar shows the game Friday"),
  W("hub-oldf", "hub", "Their old fashioned is the best in town"),
  W("hub-patio", "hub", "The patio bar gets crowded early"),
  W("hub-last", "hub", "Last call is at two on Fridays"),
  W("hub-dive", "hub", "The dive bar has cheap pitchers"),
  W("hub-book", "hub", "We should book a table for Friday"),
  W("hub-tap", "hub", "The taproom has twenty beers on tap"),
  W("hub-tender", "hub", "My favorite bartender works Fridays"),
];

const CELIAC = [
  W("apex", "apex", "I have celiac disease, so no wheat or gluten for me"),
  W("bridge", "bridge", "I always bring the sourdough loaf to Sunday brunch"),
  W("hub-time", "hub", "Sunday brunch starts at eleven"),
  W("hub-host", "hub", "Maya is hosting brunch this Sunday"),
  W("hub-mimosas", "hub", "Someone always makes a pitcher of mimosas"),
  W("hub-eggs", "hub", "The egg casserole goes in the oven at ten"),
  W("hub-bacon", "hub", "There will be a big platter of bacon"),
  W("hub-pancakes", "hub", "The pancakes get maple syrup on the side"),
  W("hub-coffee", "hub", "The coffee urn is in the dining room"),
  W("hub-seats", "hub", "We need two extra chairs for brunch"),
  W("hub-flowers", "hub", "The centerpiece is sunflowers this week"),
  W("hub-playlist", "hub", "The brunch playlist is all jazz"),
  W("hub-fruit", "hub", "Someone is bringing a fruit salad"),
  W("hub-quiche", "hub", "The spinach quiche is already in the fridge"),
  W("hub-parking", "hub", "Street parking is free on Sundays"),
  W("hub-invite", "hub", "The brunch invite went out on Thursday"),
  W("hub-waffles", "hub", "The waffle iron is on the counter"),
  W("hub-jam", "hub", "There is homemade strawberry jam in the pantry"),
  W("ctrl-cat", "control", "My cat is named Koneko"),
  W("ctrl-job", "control", "I work as a software architect"),
];

const PEANUT = [
  W("apex", "apex", "I'm severely allergic to peanuts"),
  W("bridge", "bridge", "The Thai place on Fifth has the best pad thai"),
  W("hub-friday", "hub", "Friday dinner is our usual night out"),
  W("hub-reserve", "hub", "We should reserve a table for Friday"),
  W("hub-italian", "hub", "The Italian restaurant downtown has a prix fixe"),
  W("hub-taco", "hub", "The taco truck parks on Oak after six"),
  W("hub-ramen", "hub", "The new ramen shop has a forty-minute wait"),
  W("hub-pizza", "hub", "The wood-fired pizza place takes walk-ins"),
  W("hub-sushi", "hub", "The sushi bar on Main is cash only"),
  W("hub-bbq", "hub", "The barbecue joint closes at nine on Fridays"),
  W("hub-parking", "hub", "Parking downtown is worse on Friday nights"),
  W("hub-uber", "hub", "Uber surge hits around seven"),
  W("hub-split", "hub", "We usually split the bill evenly"),
  W("hub-group", "hub", "Eight people are coming to dinner"),
  W("hub-dress", "hub", "The dress code is casual Friday"),
  W("hub-movie", "hub", "The late movie starts at ten-thirty"),
  W("hub-bar", "hub", "There is a cocktail bar next to the Thai place"),
  W("hub-allergy-menu", "hub", "Most places downtown have an allergy menu now"),
  W("ctrl-tea", "control", "I prefer tea over coffee"),
  W("ctrl-cat", "control", "My cat is named Koneko"),
];

const SOBER = [
  W("apex", "apex", "I'm sober, I don't drink alcohol"),
  W("bridge", "bridge", "The new wine bar on Oak has a great happy hour"),
  W("hub-friday", "hub", "Friday happy hour starts at five"),
  W("hub-pub", "hub", "We usually meet at the pub after work"),
  W("hub-brewery", "hub", "The brewery has a new IPA on tap"),
  W("hub-cocktails", "hub", "The cocktail list won an award last year"),
  W("hub-pitchers", "hub", "Pitchers are half off on Fridays"),
  W("hub-whiskey", "hub", "The whiskey flight is the house specialty"),
  W("hub-patio", "hub", "The patio fills up before six"),
  W("hub-dj", "hub", "A DJ plays at the bar on Friday nights"),
  W("hub-uber", "hub", "Uber surge pricing hits after midnight"),
  W("hub-last", "hub", "Last call is at two"),
  W("hub-sports", "hub", "The sports bar is showing the game"),
  W("hub-speakeasy", "hub", "The speakeasy requires a reservation"),
  W("hub-taproom", "hub", "The taproom has twenty beers on tap"),
  W("hub-parking", "hub", "Parking on Oak is meter-only after five"),
  W("ctrl-job", "control", "I work as a software architect"),
  W("ctrl-night", "control", "I usually code late at night"),
];

const MIGRAINE = [
  W("apex", "apex", "Bright flashing lights give me migraines"),
  W("bridge", "bridge", "The club downtown has an incredible strobe light show"),
  W("hub-tonight", "hub", "Everyone wants to go dancing tonight"),
  W("hub-cover", "hub", "The cover charge is twenty after ten"),
  W("hub-dj", "hub", "The resident DJ plays until three"),
  W("hub-line", "hub", "The line around the block starts at nine"),
  W("hub-uber", "hub", "Uber drop-off is on the side street"),
  W("hub-coat", "hub", "The coat check is cash only"),
  W("hub-guest", "hub", "The guest list closes at eleven"),
  W("hub-floor", "hub", "The main floor gets packed after midnight"),
  W("hub-vip", "hub", "A VIP booth needs a bottle service minimum"),
  W("hub-water", "hub", "They charge eight dollars for water"),
  W("hub-after", "hub", "The afterparty is at a warehouse across town"),
  W("hub-playlist", "hub", "The opening set is all 90s house"),
  W("hub-security", "hub", "Security is checking IDs at both doors"),
  W("hub-parking", "hub", "The garage next to the club fills by ten"),
  W("ctrl-cat", "control", "My cat is named Koneko"),
  W("ctrl-tea", "control", "I prefer tea over coffee"),
];

const DOG = [
  W("apex", "apex", "I'm allergic to dogs"),
  W("bridge", "bridge", "The dog park next to the brewery is always packed"),
  W("hub-weekend", "hub", "Weekend afternoons are for being outdoors"),
  W("hub-beer", "hub", "The brewery has a new seasonal on tap"),
  W("hub-patio", "hub", "The beer garden patio is dog-friendly"),
  W("hub-food", "hub", "The food truck parks at the brewery on Saturdays"),
  W("hub-live", "hub", "There is live music in the garden at three"),
  W("hub-lawn", "hub", "People spread blankets on the lawn"),
  W("hub-kids", "hub", "The playground next door is busy on weekends"),
  W("hub-trail", "hub", "The walking trail starts behind the brewery"),
  W("hub-shade", "hub", "The only shade is under the oak trees"),
  W("hub-water", "hub", "The water fountain is by the restrooms"),
  W("hub-parking", "hub", "The lot fills up before noon on Saturday"),
  W("hub-leash", "hub", "Leash rules are posted at the park gate"),
  W("hub-hours", "hub", "The brewery garden opens at eleven"),
  W("hub-flight", "hub", "A four-beer flight is twelve dollars"),
  W("ctrl-job", "control", "I work as a software architect"),
  W("ctrl-apt", "control", "I live in a small apartment"),
];

const SHELLFISH = [
  W("apex", "apex", "I'm allergic to shellfish"),
  W("bridge", "bridge", "I make a huge seafood paella for summer block parties"),
  W("hub-party", "hub", "The block party is this Saturday at four"),
  W("hub-grill", "hub", "Someone is bringing a second grill"),
  W("hub-corn", "hub", "There will be corn on the cob for the kids"),
  W("hub-burgers", "hub", "The usual plan is burgers and hot dogs"),
  W("hub-tables", "hub", "We need to borrow two folding tables"),
  W("hub-music", "hub", "The playlist is 90s rock this year"),
  W("hub-chairs", "hub", "Bring your own lawn chair"),
  W("hub-ice", "hub", "The ice chest goes by the driveway"),
  W("hub-sunset", "hub", "The party runs until sunset"),
  W("hub-permit", "hub", "The street-closure permit is taped to the lamppost"),
  W("hub-kids-table", "hub", "The kids' table is under the oak"),
  W("hub-dessert", "hub", "Someone always brings a sheet cake"),
  W("hub-plates", "hub", "Paper plates are in the garage"),
  W("hub-rain", "hub", "If it rains we move into the garage"),
  W("ctrl-cat", "control", "My cat is named Koneko"),
  W("ctrl-tea", "control", "I prefer tea over coffee"),
];

function caseObj(o) {
  return Object.assign({ gate: false }, o);
}

function warm(id, query, relevant_writes) {
  return { id, role: "warm", query_kind: "warm", query, relevant_writes, score: false };
}
function probe(id, query, extra) {
  return Object.assign({ id, role: "probe", query_kind: "probe", query, score: true }, extra || {});
}

const crossTurn = [
  caseObj({
    id: "xt-diabetic-assoc-hostile",
    kind: "cross_turn",
    subset: "associative-carry",
    band: "bind-hostile",
    note: "H1a: warm the lemon-bars bridge, probe needs diabetic. Friday/office crowding. Stratify on bind_present (H3).",
    writes: DIABETIC_HOSTILE,
    turns: [
      warm("warm-desserts", "what desserts do I usually bring to potlucks", ["bridge"]),
      probe("probe-potluck", "what should I bring to the potluck on Friday", {
        relevant_writes: ["apex"], hub_writes: ["hub-standup", "hub-carpool", "hub-casual", "hub-parking", "hub-lunch"],
      }),
    ],
  }),
  caseObj({
    id: "xt-diabetic-direct-hostile",
    kind: "cross_turn",
    subset: "direct-leftover",
    band: "bind-hostile",
    note: "H1b: warm the apex itself (dietary constraint), then potluck probe. Strongest leftover-E on the target.",
    writes: DIABETIC_HOSTILE,
    turns: [
      warm("warm-diet", "what food constraints or dietary rules do I have", ["apex"]),
      probe("probe-potluck", "what should I bring to the potluck on Friday", {
        relevant_writes: ["apex"], hub_writes: ["hub-standup", "hub-carpool", "hub-casual", "hub-parking", "hub-lunch"],
      }),
    ],
  }),
  caseObj({
    id: "xt-diabetic-unrelated",
    kind: "cross_turn",
    subset: "unrelated-control",
    band: "bind-hostile",
    note: "Negative for H1: warming an unrelated topic (cat) must not lift diabetic. Lift ~0 is the pass.",
    writes: DIABETIC_HOSTILE,
    turns: [
      warm("warm-cat", "what is my cat's name", ["ctrl-cat"]),
      probe("probe-potluck", "what should I bring to the potluck on Friday", {
        relevant_writes: ["apex"], hub_writes: ["hub-standup", "hub-carpool", "hub-casual", "hub-parking"],
      }),
    ],
  }),
  caseObj({
    id: "xt-diabetic-hubwarm",
    kind: "cross_turn",
    subset: "hub-warm-attack",
    band: "bind-hostile",
    note: "Attack: warm the Friday/office hub cluster, then potluck. Rank must not promote hubs over the apex. rank_hub_contamination catch.",
    writes: DIABETIC_HOSTILE,
    turns: [
      warm("warm-friday", "what's going on at the office on Friday", ["hub-standup"]),
      probe("probe-potluck", "what should I bring to the potluck on Friday", {
        relevant_writes: ["apex"], hub_writes: ["hub-standup", "hub-carpool", "hub-casual", "hub-parking", "hub-lunch"],
      }),
    ],
  }),
  caseObj({
    id: "xt-diabetic-assoc-friendly",
    kind: "cross_turn",
    subset: "associative-carry",
    band: "bind-friendly",
    note: "H1a on a store where lemon-bars' K=5 neighbors are not all potluck clones, so the diabetic leaf is likelier to bind. Still n>k so recall@5 is not trivial.",
    writes: DIABETIC_FRIENDLY,
    turns: [
      warm("warm-desserts", "what desserts do I usually bring to potlucks", ["bridge"]),
      probe("probe-potluck", "what should I bring to the potluck on Friday", {
        relevant_writes: ["apex"],
      }),
    ],
  }),
  caseObj({
    id: "xt-veg-assoc-hostile",
    kind: "cross_turn",
    subset: "associative-carry",
    band: "bind-hostile",
    note: "Vegetarian leaf via mushroom-risotto bridge. Meat-dish hubs. Original A/B: this-turn bonus was 0 (leaf never bound).",
    writes: VEG_HOSTILE,
    turns: [
      warm("warm-risotto", "what vegetarian dish do I make for team dinners", ["bridge"]),
      probe("probe-dinner", "what should I cook for the team dinner on Saturday", {
        relevant_writes: ["apex"], hub_writes: ["hub-steak", "hub-roast", "hub-ribeye", "hub-brisket", "hub-chicken"],
      }),
    ],
  }),
  caseObj({
    id: "xt-heights-assoc-hostile",
    kind: "cross_turn",
    subset: "associative-carry",
    band: "bind-hostile",
    note: "Heights leaf via rooftop-bar bridge (pair cosine 0.472, the sharp one). Friday bar hubs.",
    writes: HEIGHTS_HOSTILE,
    turns: [
      warm("warm-rooftop", "tell me about that rooftop bar downtown", ["bridge"]),
      probe("probe-drinks", "where should we go for drinks on Friday night", {
        relevant_writes: ["apex"], hub_writes: ["hub-hh", "hub-pub", "hub-brewery", "hub-sports", "hub-parking"],
      }),
    ],
  }),
  caseObj({
    id: "xt-heights-direct-hostile",
    kind: "cross_turn",
    subset: "direct-leftover",
    band: "bind-hostile",
    note: "H1b: warm the phobia itself, then the drinks query. Leftover E on the apex, not via the 0.472 bridge.",
    writes: HEIGHTS_HOSTILE,
    turns: [
      warm("warm-phobia", "am I afraid of heights", ["apex"]),
      probe("probe-drinks", "where should we go for drinks on Friday night", {
        relevant_writes: ["apex"], hub_writes: ["hub-hh", "hub-pub", "hub-brewery", "hub-sports"],
      }),
    ],
  }),
  caseObj({
    id: "xt-celiac-assoc",
    kind: "cross_turn",
    subset: "associative-carry",
    band: "new-domain",
    note: "New domain, same shape: celiac leaf via sourdough-loaf bridge, Sunday-brunch hubs. Not a 0.61 near-miss to the query.",
    writes: CELIAC,
    turns: [
      warm("warm-bread", "what bread do I bake for brunch", ["bridge"]),
      probe("probe-brunch", "what should I bring to Sunday brunch", {
        relevant_writes: ["apex"], hub_writes: ["hub-time", "hub-mimosas", "hub-bacon", "hub-pancakes", "hub-waffles"],
      }),
    ],
  }),
  caseObj({
    id: "xt-peanut-assoc",
    kind: "cross_turn",
    subset: "associative-carry",
    band: "new-domain",
    note: "Peanut allergy should constrain the Thai-place rec (peanut sauce). Warm the restaurant, probe Friday dinner.",
    writes: PEANUT,
    turns: [
      warm("warm-thai", "where's that Thai restaurant I like", ["bridge"]),
      probe("probe-dinner", "where should we go for dinner on Friday", {
        relevant_writes: ["apex"], hub_writes: ["hub-friday", "hub-italian", "hub-taco", "hub-ramen", "hub-pizza"],
      }),
    ],
  }),
  caseObj({
    id: "xt-sober-assoc",
    kind: "cross_turn",
    subset: "associative-carry",
    band: "new-domain",
    note: "Sober constraint via wine-bar bridge. Alcohol hubs. Probe is after-work Friday.",
    writes: SOBER,
    turns: [
      warm("warm-winebar", "tell me about that wine bar on Oak", ["bridge"]),
      probe("probe-afterwork", "where should we go after work on Friday", {
        relevant_writes: ["apex"], hub_writes: ["hub-friday", "hub-pub", "hub-brewery", "hub-cocktails", "hub-whiskey"],
      }),
    ],
  }),
  caseObj({
    id: "xt-migraine-assoc",
    kind: "cross_turn",
    subset: "associative-carry",
    band: "new-domain",
    note: "Migraine/strobe constraint via club light-show bridge. Nightlife hubs. Sharp: lights vs dancing query share little.",
    writes: MIGRAINE,
    turns: [
      warm("warm-club", "tell me about the club downtown with the light show", ["bridge"]),
      probe("probe-dancing", "where should we go dancing tonight", {
        relevant_writes: ["apex"], hub_writes: ["hub-tonight", "hub-dj", "hub-floor", "hub-after", "hub-cover"],
      }),
    ],
  }),
  caseObj({
    id: "xt-diabetic-assoc-late-hostile",
    kind: "cross_turn",
    subset: "associative-carry",
    band: "bind-late",
    note: "H3 save-order trap: hubs written FIRST, apex LAST. Incremental K=5 bind on an already-crowded food/Friday store is the real sparsity, not the early-save edge the hostile list otherwise creates.",
    writes: [
      ...DIABETIC_HOSTILE.filter((w) => w.role === "hub" || w.role === "control"),
      ...DIABETIC_HOSTILE.filter((w) => w.role === "bridge"),
      ...DIABETIC_HOSTILE.filter((w) => w.role === "apex"),
    ],
    turns: [
      warm("warm-desserts", "what desserts do I usually bring to potlucks", ["bridge"]),
      probe("probe-potluck", "what should I bring to the potluck on Friday", {
        relevant_writes: ["apex"], hub_writes: ["hub-standup", "hub-carpool", "hub-casual", "hub-parking", "hub-lunch"],
      }),
    ],
  }),
  caseObj({
    id: "xt-veg-assoc-late-hostile",
    kind: "cross_turn",
    subset: "associative-carry",
    band: "bind-late",
    note: "H3 save-order trap for vegetarian: meat-dish hubs first, risotto, apex last. The original A/B's bonus-0 may be this, not 'K=5 is always too sparse'.",
    writes: [
      ...VEG_HOSTILE.filter((w) => w.role === "hub"),
      ...VEG_HOSTILE.filter((w) => w.role === "bridge"),
      ...VEG_HOSTILE.filter((w) => w.role === "apex"),
    ],
    turns: [
      warm("warm-risotto", "what vegetarian dish do I make for team dinners", ["bridge"]),
      probe("probe-dinner", "what should I cook for the team dinner on Saturday", {
        relevant_writes: ["apex"], hub_writes: ["hub-steak", "hub-roast", "hub-ribeye", "hub-brisket", "hub-chicken"],
      }),
    ],
  }),
  caseObj({
    id: "xt-dog-assoc",
    kind: "cross_turn",
    subset: "associative-carry",
    band: "new-domain",
    note: "Dog allergy via dog-park-next-to-brewery bridge. Outdoor/beer hubs.",
    writes: DOG,
    turns: [
      warm("warm-park", "where's that dog park by the brewery", ["bridge"]),
      probe("probe-beer", "where's a good outdoor spot for a beer this weekend", {
        relevant_writes: ["apex"], hub_writes: ["hub-weekend", "hub-beer", "hub-patio", "hub-live", "hub-lawn"],
      }),
    ],
  }),
];

function singleProbe(id, kind, subset, band, note, writes, query, extra) {
  return caseObj({
    id, kind, subset, band, note, writes,
    queries: [probe("probe-1", query, extra)],
  });
}

const weakRecall = [
  singleProbe("wr-diabetic-potluck", "weak_recall", "this-turn", "bind-hostile",
    "This-turn baseline of the original field-rescue miss. Target is rank ~21, not a cosine near-miss. Compare to xt-diabetic-assoc-hostile.",
    DIABETIC_HOSTILE, "what should I bring to the potluck on Friday",
    { relevant_writes: ["apex"], hub_writes: ["hub-standup", "hub-carpool", "hub-casual", "hub-parking", "hub-lunch"] }),
  singleProbe("wr-veg-dinner", "weak_recall", "this-turn", "bind-hostile",
    "This-turn baseline: vegetarian leaf, meat-dish crowding. Original A/B bonus was 0.",
    VEG_HOSTILE, "what should I cook for the team dinner on Saturday",
    { relevant_writes: ["apex"], hub_writes: ["hub-steak", "hub-roast", "hub-ribeye", "hub-brisket", "hub-chicken"] }),
  singleProbe("wr-heights-drinks", "weak_recall", "this-turn", "bind-hostile",
    "This-turn baseline: heights leaf, pair cosine 0.472. The sharp fixture, not s=0.61.",
    HEIGHTS_HOSTILE, "where should we go for drinks on Friday night",
    { relevant_writes: ["apex"], hub_writes: ["hub-hh", "hub-pub", "hub-brewery", "hub-sports", "hub-parking"] }),
  singleProbe("wr-celiac-brunch", "weak_recall", "this-turn", "new-domain",
    "Celiac vs Sunday brunch. Target shares little vocabulary with the query.",
    CELIAC, "what should I bring to Sunday brunch",
    { relevant_writes: ["apex"], hub_writes: ["hub-time", "hub-mimosas", "hub-bacon", "hub-pancakes"] }),
  singleProbe("wr-peanut-dinner", "weak_recall", "this-turn", "new-domain",
    "Peanut allergy vs Friday-dinner restaurant choice.",
    PEANUT, "where should we go for dinner on Friday",
    { relevant_writes: ["apex"], hub_writes: ["hub-friday", "hub-italian", "hub-taco", "hub-ramen"] }),
  singleProbe("wr-sober-drinks", "weak_recall", "this-turn", "new-domain",
    "Sober vs after-work drinks. Alcohol hubs.",
    SOBER, "where should we go after work on Friday",
    { relevant_writes: ["apex"], hub_writes: ["hub-friday", "hub-pub", "hub-brewery", "hub-cocktails"] }),
  singleProbe("wr-migraine-club", "weak_recall", "this-turn", "new-domain",
    "Migraine/strobe vs dancing. Sharp: flashing-lights constraint is far from the dancing query.",
    MIGRAINE, "where should we go dancing tonight",
    { relevant_writes: ["apex"], hub_writes: ["hub-tonight", "hub-dj", "hub-floor", "hub-after"] }),
  singleProbe("wr-dog-park", "weak_recall", "this-turn", "new-domain",
    "Dog allergy vs outdoor beer. The park is associated, not lexical.",
    DOG, "where's a good outdoor spot for a beer this weekend",
    { relevant_writes: ["apex"], hub_writes: ["hub-weekend", "hub-beer", "hub-patio", "hub-live"] }),
  singleProbe("wr-diabetic-late", "weak_recall", "this-turn", "bind-late",
    "This-turn baseline of the late-bind diabetic store (hubs first, apex last).",
    [
      ...DIABETIC_HOSTILE.filter((w) => w.role === "hub" || w.role === "control"),
      ...DIABETIC_HOSTILE.filter((w) => w.role === "bridge"),
      ...DIABETIC_HOSTILE.filter((w) => w.role === "apex"),
    ],
    "what should I bring to the potluck on Friday",
    { relevant_writes: ["apex"], hub_writes: ["hub-standup", "hub-carpool", "hub-casual", "hub-parking", "hub-lunch"] }),
  singleProbe("wr-shellfish-paella", "weak_recall", "this-turn", "new-domain",
    "Shellfish allergy vs block-party cooking. Paella is the associated dish, not a cosine near-hit to 'block party'.",
    SHELLFISH, "what should I cook for the block party",
    { relevant_writes: ["apex"], hub_writes: ["hub-party", "hub-grill", "hub-burgers", "hub-corn"] }),
];

const hubVsApex = [
  singleProbe("hub-diabetic-potluck", "hub_vs_apex", "single-turn", "bind-hostile",
    "Canonical Friday/office hub vs diabetic apex. The w=1.0 A/B promoted casual-dress/carpool, not the leaf.",
    DIABETIC_HOSTILE, "what should I bring to the potluck on Friday",
    { relevant_writes: ["apex"], hub_writes: ["hub-standup", "hub-carpool", "hub-casual", "hub-parking", "hub-lunch", "hub-printer", "hub-elevator"] }),
  singleProbe("hub-veg-dinner", "hub_vs_apex", "single-turn", "bind-hostile",
    "Meat-dish hubs vs vegetarian apex on a cooking query.",
    VEG_HOSTILE, "what should I cook for the team dinner on Saturday",
    { relevant_writes: ["apex"], hub_writes: ["hub-steak", "hub-roast", "hub-ribeye", "hub-brisket", "hub-chicken"] }),
  singleProbe("hub-heights-drinks", "hub_vs_apex", "single-turn", "bind-hostile",
    "Friday-bar hubs vs heights apex on a drinks query.",
    HEIGHTS_HOSTILE, "where should we go for drinks on Friday night",
    { relevant_writes: ["apex"], hub_writes: ["hub-hh", "hub-pub", "hub-brewery", "hub-sports", "hub-parking", "hub-dive"] }),
  singleProbe("hub-celiac-brunch", "hub_vs_apex", "single-turn", "new-domain",
    "Brunch-food hubs vs celiac apex.",
    CELIAC, "what should I bring to Sunday brunch",
    { relevant_writes: ["apex"], hub_writes: ["hub-mimosas", "hub-bacon", "hub-pancakes", "hub-waffles", "hub-quiche"] }),
  singleProbe("hub-sober-wine", "hub_vs_apex", "single-turn", "new-domain",
    "Alcohol hubs vs sober apex.",
    SOBER, "where should we go after work on Friday",
    { relevant_writes: ["apex"], hub_writes: ["hub-pub", "hub-brewery", "hub-cocktails", "hub-whiskey", "hub-pitchers"] }),
  caseObj({
    id: "hub-diabetic-after-friday-warm",
    kind: "hub_vs_apex",
    subset: "hub-warm-attack",
    band: "bind-hostile",
    note: "Same store as hub-diabetic-potluck, but turn 1 warms the Friday cluster. Combiner must not treat leftover hub energy as the rescue.",
    writes: DIABETIC_HOSTILE,
    turns: [
      warm("warm-friday", "what's going on at the office on Friday", ["hub-standup"]),
      probe("probe-potluck", "what should I bring to the potluck on Friday", {
        relevant_writes: ["apex"],
        hub_writes: ["hub-standup", "hub-carpool", "hub-casual", "hub-parking", "hub-lunch"],
      }),
    ],
  }),
];

function writeJsonl(name, rows) {
  const file = path.join(dir, name);
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(file, body);
  console.log(name + "  " + rows.length + " cases  " + body.length + " bytes");
}

writeJsonl("cross-turn.jsonl", crossTurn);
writeJsonl("weak-recall.jsonl", weakRecall);
writeJsonl("hub-vs-apex.jsonl", hubVsApex);
