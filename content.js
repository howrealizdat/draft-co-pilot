// Draft Co-Pilot — content script (v2.3)
// Auto-detects contest; value(VBD/tiers) + winning-draft heuristics (don't-reach, STEAL, scarcity,
// structure floor); daily injury layer WITH beneficiary boosts; live re-planning; and a SELF-GRADE.
// v2.1: (1) streaming-aware QB baseline — QB1 valued over the best QB likely to survive to your NEXT
//       pick, not the static QB12, so it stops over-rating elite QBs early; (2) per-seat early-round
//       blueprint that nudges picks by your draft slot; (3) self-grade now penalizes reaches
//       (sign-fixed) and early-QB opportunity cost in 1-QB leagues.
// v2.2: symmetric RB/WR depth-balancing — in flex/bench rounds the engine favors whichever of RB/WR
//       is thinner and discourages stacking the deeper one, preventing the RB-glut (and mirror WR-glut).
// v2.3: strength-of-schedule tilt — a capped (+/-1.5), position-specific nudge from real ESPN defense
//       data (read at runtime from sos.json). No-op until that file is populated; never overrides VBD.
// v2.4: green/yellow/red color-code on each recommendation — scored in THIS league (projections are
//       league-scored), blending value + roster need so the next pick that helps you win is obvious.
// v2.5: the panel is draggable — grab the header (⠿) and move it anywhere; position is remembered.
//       (SOS data now populated in sos.json from real ESPN schedule + defense strength, so the tilt is live.)
// v2.6: stacking bonus — boosts a same-team pass-catcher when you have the QB (and the QB when you have
//       the pass-catcher), for correlated upside. Capped tiebreaker (WR/TE +1.5, RB +0.8); never a driver.
// v2.7: "load up on one elite offense" — extends stacking so a 2nd/3rd player from a high-scoring offense
//       you already own (the Purdy/CMC/Kittle play) gets a bonus scaled by that offense's strength;
//       gated to good offenses only, whole stack contribution capped at +3. Flags an "onslaught" at 2+.
// v2.8: persistent "STACK OPTIONS" panel section — ALWAYS lists every available teammate of a player you
//       roster (purple), even marginal/weak-offense ones (flagged), so you never miss a stack. You decide.
// v2.9: for fun — when you roster 3+ players from one team (a TRIPLE STACK), show a banner and announce it
//       out loud in a British female voice (Web Speech API), once per team.
// v2.9.1: version now shown in the panel header (so you can confirm what's loaded); triple-stack trigger
//         counts SKILL players only (QB/RB/WR/TE), so K/D-ST don't create a false 3-stack.
// v2.10: "TOP STACKS" reference section at the bottom — a curated list of the season's best NFL stacks
//        (read from stacks.json, refreshed each morning by the scheduled task) to eyeball while drafting.
// v2.11: STACK-FIRST targeting — picks the most-gettable top stack for your seat/board, shows it as a live
//        🎯 checklist, and pushes its available pieces to the top of the picks so you draft around it.
// v2.12: target = the stack that's CHEAPEST to complete given who's left (least reach), re-chosen every pick;
//        a target piece is only pushed to the top when it likely WON'T survive to your next pick ("grab now"),
//        otherwise it's a gentle nudge so you take the better player and let the stack come to you.
// v2.13: TOP STACKS + targeting now built from LIVE ESPN 2026 rosters (each team's real QB + top 2 pass-
//        catchers, ranked by offense strength) — always current, no more stale hand-curated lists.
// v2.14: positional CLIFF factor — generalizes the QB wait-cost logic to RB/WR/TE. Each pick is weighted by
//        the points drop to the next same-position player likely to survive to your next pick, so BEST PICK
//        reacts to positional runs/cliffs (grab the last scarce RB; don't reach on deep WR). Capped at +3.
// v2.15: stacking SIMPLIFIED — removed stack targeting, the STACK OPTIONS panel, and all stack pick-bonuses
//        so BEST PICK is pure value/need/cliff/schedule. Kept only the "STACK UNLOCKED" alert (3 skill
//        players from one team) and the TOP STACKS reference list.
// v2.16: each BEST PICK shows the player's consensus draft ROUND from live ADP ("exp R3") — expert/field
//        placement, not our theory. Live ADP self-updates daily with injuries/news; green ↓ = slipped = value.
// v2.17: position-aware EDGE tags on each pick — shows WHY a player wins under this league's scoring from his
//        projected profile (RB goal-line/receiving, WR target-hog/big-play, TE primary target, QB rushing,
//        K high-scoring offense, D/ST matchup). Read-only; the value/ranking already accounts for these.
(function () {
  if (!/\/football\/draft/.test(location.pathname)) return;
  if (document.getElementById('dcp')) { document.getElementById('dcp').style.display = 'block'; return; }

  var VERSION = '2.17'; // shown in the panel header so you can confirm which build is actually loaded.
  var REAL = 0; // ← SET THIS to your ESPN league ID (the leagueId=XXXXXXX in your league URL). During a live draft the ID is auto-detected from the draft-room URL; this constant is only the fallback used for mock drafts.
  var POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DST' };
  // ESPN proTeamId -> abbreviation, for the strength-of-schedule lookup in sos.json.
  var PROTEAM = { 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WSH', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU' };
  var REPL = { QB: 12, RB: 30, WR: 36, TE: 12, K: 11, DST: 11 };
  var SOS_CAP = 1.5; // strength-of-schedule tilt is clamped to +/- this — a tiebreaker, never a driver.
  var STACK_WR = 1.5, STACK_RB = 0.8; // v2.6 stacking bonus (QB + same-team pass-catcher); capped tiebreaker.
  var STACK_OFF = 1.0, STACK_MAX = 3.0; // v2.7 "load up on one elite offense" bonus + overall stack cap.
  var CLIFF_SCALE = 0.6, CLIFF_CAP = 3; // v2.14 positional drop-off ("cliff") factor for RB/WR/TE.
  var API = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/';

  var SCORE_LID = REAL;
  var START = { QB: 1, RB: 2, WR: 2, TE: 1 };
  var FLEXN = 1, OPN = 0, SUPERFLEX = false;
  var MAX = { QB: 2, RB: 6, WR: 11, TE: 2, K: 2, DST: 2 };
  var SLOTS_TPL = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'D/ST', 'K'];
  var CONTEST = 'your league';
  var MYSLOT = null, LSIZE = 10, ROUNDS = 16, MYPICKS = [];
  var MODEL = null, BYID = {}, ADJ = { players: {}, updated: '' };
  var SOSD = { teams: {}, updated: '' }; // strength-of-schedule layer (loaded from sos.json)
  var STK = { stacks: [], updated: '' }; // v2.10 curated top NFL stacks (loaded from stacks.json)
  var MODELIDX = null; // v2.11 normalized-name -> MODEL player, for matching stacks.json names
  var TARGET_BONUS = 8; // v2.11 push the target stack's available pieces toward the top of the picks
  var STACKS = null; // v2.13 top stacks computed from LIVE ESPN 2026 rosters (cached; rebuilt on model load)
  var OFFN = {}; // v2.7 per-team offense strength (0..1), computed from projections in buildModel
  var announcedStacks = {}; // v2.9 teams we've already shouted "triple stack!" for (announce once)
  var SEEN = {};

  function lidNow() { var m = location.search.match(/leagueId=(\d+)/); return m ? +m[1] : REAL; }
  function teamNow() { var m = location.search.match(/teamId=(\d+)/); return m ? +m[1] : null; }

  function normCdf(x, mean, sd) {
    if (sd <= 0) return x >= mean ? 1 : 0;
    var z = (x - mean) / (sd * Math.SQRT2), t = 1 / (1 + 0.3275911 * Math.abs(z));
    var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    return 0.5 * (1 + (z >= 0 ? y : -y));
  }
  function scrapeMaxes() {
    var maxes = {}, bt = document.body.innerText || '', re = /(QB|RB|WR|TE|K|D\/ST)\s*(\d+)\s*\/\s*(\d+)/g, m;
    while (m = re.exec(bt)) { var p = (m[1] === 'D/ST') ? 'DST' : m[1]; maxes[p] = +m[3]; }
    return maxes;
  }
  function detectSlot(s) {
    var tid = teamNow();
    var po = s && s.draftSettings && s.draftSettings.pickOrder;
    if (po && po.length && tid) { var idx = po.indexOf(tid); if (idx >= 0) { MYSLOT = idx + 1; LSIZE = po.length; return; } }
    if (s && s.size) LSIZE = s.size;
    var bt = document.body.innerText || '';
    var m = bt.match(/Round\s*1[, ]+Pick\s*(\d+)/i) || bt.match(/first pick[\s\S]{0,40}?Pick\s*(\d+)/i);
    if (m) MYSLOT = +m[1];
  }
  function myPicksArr(slot, size, rounds) { var a = []; for (var r = 1; r <= rounds; r++) a.push((r % 2 === 1) ? (r - 1) * size + slot : r * size - slot + 1); return a; }
  function nextMyPick(pn) { for (var i = 0; i < MYPICKS.length; i++) if (MYPICKS[i] > pn) return MYPICKS[i]; return pn + (LSIZE || 10); }

  // v2.1 streaming-aware baseline: projected pts of the best player at `pos` likely to still be
  // available at pick `byPick` (>=50% survival), excluding `exclude`. Used so QB1's value is its
  // marginal points over the QB you'd realistically get if you waited, not over the static QB12.
  function expectedAvailPts(pos, byPick, avail, exclude) {
    var cands = avail.filter(function (q) { return q.pos === pos && q !== exclude; })
      .sort(function (a, b) { return b.pts - a.pts; });
    for (var i = 0; i < cands.length; i++) {
      var q = cands[i];
      var surv = (q.adp >= 999) ? 1 : (1 - normCdf(byPick, q.adp, Math.max(4, q.adp / 4)));
      if (surv >= 0.5) return q.pts;
    }
    return cands.length ? cands[cands.length - 1].pts : 0;
  }

  // v2.1 per-seat blueprint: early-round positional lean by draft slot. Early seats can stay
  // balanced; turn/late seats bank scarce RB at the wheel before the WR run. Soft nudge only —
  // never overrides a clear steal or value pick. No QB before R6 (the QB baseline enforces that).
  function seatBlueprint(slot, size) {
    if (!slot) return null;
    var f = (slot - 1) / ((size || 10) - 1 || 1);
    if (f <= 0.34) return ['RB', 'WR', 'RB', 'WR', 'WR', 'RB'];
    if (f <= 0.67) return ['RB', 'RB', 'WR', 'WR', 'WR', 'RB'];
    return ['RB', 'RB', 'WR', 'WR', 'WR', 'WR'];
  }

  // v2.9 just for fun: announce a triple stack out loud in a British female voice.
  function sayTripleStack(team) {
    try {
      if (!('speechSynthesis' in window)) return;
      var u = new SpeechSynthesisUtterance('Triple stack! ' + team + '. Brilliant.');
      var vs = window.speechSynthesis.getVoices() || [];
      var pick = vs.filter(function (v) { return /en-GB/i.test(v.lang) && /female|Sonia|Libby|Kate|Serena|Stephanie|Martha|Amelie|UK English Female/i.test(v.name); })[0]
        || vs.filter(function (v) { return /en-GB/i.test(v.lang); })[0]
        || vs.filter(function (v) { return /female/i.test(v.name); })[0];
      if (pick) u.voice = pick;
      u.lang = 'en-GB'; u.pitch = 1.35; u.rate = 1.0;
      window.speechSynthesis.speak(u);
    } catch (e) { }
  }
  try { window.speechSynthesis && window.speechSynthesis.getVoices(); } catch (e) { } // warm up voice list

  // v2.11 stack-targeting helpers: match stacks.json names to MODEL players and pick the best gettable stack.
  function stkNorm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function stackPieces(s) { var a = [s.qb || '']; (s.pieces || '').split('+').forEach(function (x) { a.push(x.trim()); }); return a.filter(Boolean); }
  function buildModelIdx() { if (MODELIDX || !MODEL) return; MODELIDX = {}; MODEL.forEach(function (p) { var k = stkNorm(p.name); if (k) MODELIDX[k] = p; }); }
  // Returns the best stack to chase given the live board: prefer one you've already started, then the
  // highest-ranked stack still ≥2 pieces alive. Each piece tagged have / open (draft now) / gone.
  // survival: probability a player (by ADP) is still on the board at pick `byPick`.
  function surviveProb(adp, byPick) { return (!adp || adp >= 999) ? 1 : (1 - normCdf(byPick, adp, Math.max(4, adp / 4))); }

  // v2.13 build the top stacks from LIVE ESPN 2026 data: each team's actual top QB + its 2 best pass-catchers,
  // ranked by offense strength. Always current (uses real proTeamId), so no stale rosters from a hand list.
  function computeTopStacks() {
    if (STACKS) return STACKS;
    if (!MODEL) return [];
    var byTeam = {};
    MODEL.forEach(function (p) { if (!p.team || !p.pos) return; (byTeam[p.team] = byTeam[p.team] || []).push(p); });
    var out = [];
    Object.keys(byTeam).forEach(function (t) {
      var ps = byTeam[t];
      var qb = ps.filter(function (p) { return p.pos === 'QB'; }).sort(function (a, b) { return b.pts - a.pts; })[0];
      var catchers = ps.filter(function (p) { return p.pos === 'WR' || p.pos === 'TE'; }).sort(function (a, b) { return b.pts - a.pts; }).slice(0, 2);
      if (!qb || catchers.length < 1) return;
      out.push({ team: t, players: [qb].concat(catchers), strength: (OFFN[t] || 0) });
    });
    out.sort(function (a, b) { return b.strength - a.strength; });
    STACKS = out.slice(0, 12);
    return STACKS;
  }

  // v2.17 position-aware "edge" tag: surfaces WHY a player wins under this league's scoring, from his
  // projected per-game profile (×17 ≈ season). Read-only — the value/ranking already bakes these in.
  function edgeTag(p) {
    if (!p || !p.pos) return '';
    var rec = Math.round((p.rec || 0) * 17), ry = Math.round((p.ry || 0) * 17), rtd = Math.round((p.rtd || 0) * 17);
    var ypc = (p.rec > 0) ? (p.rey / p.rec) : 0;
    if (p.pos === 'QB') return ry >= 420 ? ('🏃 rushing QB · ~' + ry + ' rush yds') : '';
    if (p.pos === 'RB') { if (rtd >= 9) return '🥅 goal-line role · ~' + rtd + ' rush TD'; if (rec >= 55) return '🎯 receiving back · ~' + rec + ' catches'; return ''; }
    if (p.pos === 'WR') { if (rec >= 95) return '🎯 target hog · ~' + rec + ' catches'; if (ypc >= 14) return '💥 big-play · ' + ypc.toFixed(0) + ' yds/catch'; return ''; }
    if (p.pos === 'TE') return rec >= 70 ? ('🎯 primary target · ~' + rec + ' catches') : '';
    if (p.pos === 'K') return (OFFN[p.team] || 0) >= 0.6 ? '🟢 high-scoring offense · extra PATs/FGs' : '';
    if (p.pos === 'DST') return '🛡 stream by matchup';
    return '';
  }

  function targetStack(st) {
    var list = computeTopStacks(); if (!list.length) return null;
    var pickNo = st.n + 1, nextPick = nextMyPick(pickNo);
    var myNl = {}; (st.myPlayers || []).forEach(function (mp) { if (mp.nl) myNl[mp.nl] = 1; });
    var best = null;
    list.forEach(function (s, idx) {
      var pieces = [], rostered = 0, avail = 0, reach = 0;
      s.players.forEach(function (pl) {
        var status, now = false;
        if (myNl[pl.nl]) { status = 'have'; rostered++; }
        else if (!st.drafted[pl.nl]) {
          status = 'open'; avail++;
          // reach cost: if he WON'T survive to your next pick, how far before ADP you'd take him now;
          // if he WILL survive, cost 0 (wait — he comes to you). Lowest total reach = easiest stack.
          var willSurvive = surviveProb(pl.adp, nextPick) >= 0.5;
          now = !willSurvive;
          reach += willSurvive ? 0 : Math.max(0, (pl.adp || 999) - pickNo);
        } else { status = 'gone'; }
        pieces.push({ name: pl.name, pl: pl, status: status, now: now });
      });
      if ((rostered + avail) < 2) return; // dead stack — skip
      var score = rostered * 1000 - reach + avail * 2 + (32 - idx) * 0.1;
      if (!best || score > best.score) best = { stack: s, idx: idx, pieces: pieces, rostered: rostered, avail: avail, reach: reach, score: score };
    });
    return best;
  }

  function detectSettings(cb) {
    var lid = lidNow();
    fetch(API + lid + '?view=mSettings', { credentials: 'include' }).then(function (r) { return r.json(); })
      .then(function (d) {
        var s = d && d.settings, c = s && s.rosterSettings && s.rosterSettings.lineupSlotCounts;
        if (s && s.scoringSettings && c) {
          SCORE_LID = lid;
          var g = function (id) { return c[id] || 0; };
          var qb = g(0), rb = g(2), wr = g(4), te = g(6), op = g(7), flex = g(23) + g(3) + g(5), dst = g(16), k = g(17);
          OPN = op; SUPERFLEX = op > 0; START = { QB: qb, RB: rb, WR: wr, TE: te }; FLEXN = flex;
          var tot = 0; Object.keys(c).forEach(function (key) { if (key !== '21') tot += c[key]; }); if (tot) ROUNDS = tot;
          var tpl = [], i;
          for (i = 0; i < qb; i++) tpl.push('QB'); for (i = 0; i < rb; i++) tpl.push('RB');
          for (i = 0; i < wr; i++) tpl.push('WR'); for (i = 0; i < te; i++) tpl.push('TE');
          for (i = 0; i < flex; i++) tpl.push('FLEX'); for (i = 0; i < op; i++) tpl.push('SFLX');
          for (i = 0; i < dst; i++) tpl.push('D/ST'); for (i = 0; i < k; i++) tpl.push('K');
          if (tpl.length) SLOTS_TPL = tpl;
          CONTEST = (lid === REAL ? 'your league' : 'league ' + lid) + (SUPERFLEX ? ' • superflex' : '');
        } else { SCORE_LID = REAL; CONTEST = 'mock — using your league'; }
        try { detectSlot(s); } catch (e) { }
        if (MYSLOT) MYPICKS = myPicksArr(MYSLOT, LSIZE || 10, ROUNDS || 16);
        cb();
      })
      .catch(function () { SCORE_LID = REAL; CONTEST = 'mock — using your league'; try { detectSlot(null); } catch (e) { } if (MYSLOT) MYPICKS = myPicksArr(MYSLOT, LSIZE || 10, ROUNDS || 16); cb(); });
  }

  function loadAdjustments(cb) {
    fetch(chrome.runtime.getURL('adjustments.json')).then(function (r) { return r.json(); })
      .then(function (j) { ADJ = j || ADJ; cb(); }).catch(function () { cb(); });
  }

  // v2.3: load the strength-of-schedule layer. Optional — if the file is missing or its `teams`
  // map is empty, SOSD stays empty and the SOS tilt is a no-op (tool runs exactly as v2.2).
  function loadSos(cb) {
    fetch(chrome.runtime.getURL('sos.json')).then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.teams) SOSD = j; cb(); }).catch(function () { cb(); });
  }

  // v2.10: load the curated top-stacks reference list (refreshed each morning by the scheduled task).
  function loadStacks(cb) {
    fetch(chrome.runtime.getURL('stacks.json')).then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.stacks) STK = j; cb(); }).catch(function () { cb(); });
  }

  function buildModel(cb) {
    var f = { players: { limit: 500, sortPercOwned: { sortPriority: 1, sortAsc: false } } };
    fetch(API + SCORE_LID + '?view=kona_player_info', { credentials: 'include', headers: { 'X-Fantasy-Filter': JSON.stringify(f) } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var arr = (d.players || []).map(function (e) {
          var pl = e.player || {}; var s = (pl.stats || []).filter(function (x) { return x.seasonId === 2026 && x.statSourceId === 1; })[0];
          var own = pl.ownership || {};
          var ss = (s && s.stats) || {}; var gv = function (id) { return ss[id] != null ? ss[id] : 0; };
          return { id: e.id, name: pl.fullName || '?', pos: POS[pl.defaultPositionId] || '?', team: PROTEAM[pl.proTeamId] || '', pts: (s && s.appliedTotal != null) ? Math.round(s.appliedTotal * 10) / 10 : 0, adp: (own.averageDraftPosition && own.averageDraftPosition > 0) ? own.averageDraftPosition : 999,
            ry: gv(24), rtd: gv(25), rec: gv(53), rey: gv(42), retd: gv(43) }; // v2.17 projected per-game components for edge tags
        }).filter(function (p) { return p.pts > 0 && p.pos !== '?'; });
        var bp = {}; arr.forEach(function (p) { (bp[p.pos] = bp[p.pos] || []).push(p); });
        Object.keys(bp).forEach(function (k) { bp[k].sort(function (a, b) { return b.pts - a.pts; }); });
        var bl = {}; Object.keys(REPL).forEach(function (k) { var a = bp[k] || []; bl[k] = (a[REPL[k] - 1] || { pts: 0 }).pts; });
        arr.forEach(function (p) {
          p.vbd = Math.round((p.pts - bl[p.pos]) * 10) / 10; p.nl = p.name.toLowerCase();
          var a = ADJ.players && ADJ.players[p.nl];
          if (a) { p.vbd = Math.round((p.vbd - (a.pen || 0)) * 10) / 10; p.flag = a.flag || ''; p.boost = (a.pen || 0) < 0; }
        });
        Object.keys(bp).forEach(function (k) {
          var list = bp[k].slice().sort(function (a, b) { return b.vbd - a.vbd; }), tier = 1;
          for (var i = 0; i < list.length; i++) { if (i > 0 && (list[i - 1].vbd - list[i].vbd) > 1.2) tier++; list[i].tier = tier; }
        });
        arr.sort(function (a, b) { return b.vbd - a.vbd; });
        // v2.7 offense strength per team: top QB + top2 RB + top3 WR + top TE projected pts, normalized 0..1.
        var tp = {};
        arr.forEach(function (p) { if (!p.team) return; (tp[p.team] = tp[p.team] || { QB: [], RB: [], WR: [], TE: [] }); if (tp[p.team][p.pos]) tp[p.team][p.pos].push(p.pts); });
        var topN = function (a, n) { return a.sort(function (x, y) { return y - x; }).slice(0, n).reduce(function (m, v) { return m + v; }, 0); };
        var offRaw = {}; Object.keys(tp).forEach(function (t) { var g = tp[t]; offRaw[t] = topN(g.QB, 1) + topN(g.RB, 2) + topN(g.WR, 3) + topN(g.TE, 1); });
        var offMax = Math.max.apply(null, Object.values(offRaw).concat([1]));
        OFFN = {}; Object.keys(offRaw).forEach(function (t) { OFFN[t] = Math.round(offRaw[t] / offMax * 100) / 100; });
        MODEL = arr; BYID = {}; arr.forEach(function (p) { BYID[p.id] = p; }); MODELIDX = null; STACKS = null; cb();
      })
      .catch(function (e) { var b = document.getElementById('dcpb'); if (b) b.textContent = 'Model error: ' + e.message; });
  }

  // best-lineup projected points from a list of player objects (each {pos, pts})
  function startersTotal(list) {
    var pool = { QB: [], RB: [], WR: [], TE: [], K: [], DST: [] };
    list.forEach(function (p) { if (pool[p.pos]) pool[p.pos].push(p.pts); });
    Object.keys(pool).forEach(function (k) { pool[k].sort(function (a, b) { return b - a; }); });
    var idx = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 }, total = 0;
    SLOTS_TPL.forEach(function (lab) { if (lab === 'FLEX' || lab === 'SFLX') return; var pos = lab === 'D/ST' ? 'DST' : lab; var v = pool[pos] && pool[pos][idx[pos]]; if (v != null) { total += v; idx[pos]++; } });
    SLOTS_TPL.forEach(function (lab) { if (lab !== 'FLEX' && lab !== 'SFLX') return; var elig = lab === 'SFLX' ? ['QB', 'RB', 'WR', 'TE'] : ['RB', 'WR', 'TE']; var best = -1, bpos = null; elig.forEach(function (pos) { var v = pool[pos] && pool[pos][idx[pos]]; if (v != null && v > best) { best = v; bpos = pos; } }); if (bpos) { total += best; idx[bpos]++; } });
    return Math.round(total * 10) / 10;
  }

  function gradeRoster(st) {
    var mp = st.myPlayers; if (!mp || mp.length < 5) return null;
    var counts = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 }; mp.forEach(function (p) { counts[p.pos] = (counts[p.pos] || 0) + 1; });
    var starterTot = (st.myTotal != null) ? st.myTotal : startersTotal(mp);
    var score, rank = null, teams = null;
    if (st.teamTotals && st.teamTotals.length > 1) {
      var sorted = st.teamTotals.slice().sort(function (a, b) { return b - a; }); teams = sorted.length;
      rank = 1; for (var i = 0; i < sorted.length; i++) { if (starterTot < sorted[i] - 0.01) rank++; }
      score = 60 * (1 - (rank - 1) / (teams - 1 || 1));   // starter strength vs the league = the core signal
    } else { score = 42; }
    var bal = counts.RB >= 4 && counts.WR >= 5 && counts.QB >= 1 && counts.TE >= 1 && counts.K >= 1 && counts.DST >= 1;
    score += bal ? 25 : 8;
    // value (sign-fixed in v2.1): steals = players who FELL to you (pickNo - adp >= 12) → reward.
    var steals = mp.filter(function (p) { return p.pickNo && p.adp > 0 && p.adp < 999 && (p.pickNo - p.adp) >= 12; }).length;
    score += Math.min(15, steals * 4);
    // reaches = players taken well BEFORE adp (adp - pickNo >= 16) → penalty (the term v2.0 dropped).
    var reaches = mp.filter(function (p) { return p.pickNo && p.adp > 0 && p.adp < 999 && (p.adp - p.pickNo) >= 16; }).length;
    score -= Math.min(12, reaches * 4);
    // early-QB opportunity cost: in 1-QB leagues, spending a rounds-1–5 pick on a QB is a value leak
    // (Hurts-in-R5) that ADP alone won't catch, since the QB is often taken near his ADP.
    var earlyQB = (!SUPERFLEX) && mp.some(function (p) { return p.pos === 'QB' && p.pickNo && p.pickNo <= (LSIZE || 10) * 5; });
    if (earlyQB) score -= 8;
    score = Math.round(Math.max(0, score));
    var L = score >= 85 ? 'A' : score >= 78 ? 'A-' : score >= 72 ? 'B+' : score >= 66 ? 'B' : score >= 60 ? 'B-' : score >= 54 ? 'C+' : score >= 48 ? 'C' : score >= 40 ? 'C-' : score >= 33 ? 'D' : 'F';
    return { letter: L, score: score, rank: rank, teams: teams, starterTot: starterTot, steals: steals, reaches: reaches, earlyQB: earlyQB, bal: bal };
  }

  // practice mode: read MY drafted players off the left roster panel (by on-screen position)
  function scrapeMyRoster() {
    var out = [], seen = {}, nodes = document.querySelectorAll('a,span,div');
    for (var i = 0; i < nodes.length && out.length < 30; i++) {
      var el = nodes[i], t = (el.textContent || '').trim().toLowerCase();
      if (t.length < 4 || t.length > 30) continue;
      var rect; try { rect = el.getBoundingClientRect(); } catch (e) { continue; }
      if (rect.width > 0 && rect.left >= 0 && rect.left < 270) {
        for (var j = 0; j < MODEL.length; j++) { if (t === MODEL[j].nl) { if (!seen[MODEL[j].nl]) { seen[MODEL[j].nl] = 1; out.push(MODEL[j]); } break; } }
      }
    }
    return out;
  }

  function domState() {
    var labelRe = /R\d+,\s*P\d+/, nodes = document.querySelectorAll('div,span,li');
    for (var i = 0; i < nodes.length; i++) {
      var t = nodes[i].textContent || ''; if (t.length < 6 || t.length > 140) continue;
      if (labelRe.test(t)) { var low = t.toLowerCase(); for (var j = 0; j < MODEL.length; j++) { if (low.indexOf(MODEL[j].nl) > -1) { SEEN[MODEL[j].nl] = 1; break; } } }
    }
    var roster = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 }, maxes = {}, bt = document.body.innerText || '';
    var re = /(QB|RB|WR|TE|K|D\/ST)\s*(\d+)\s*\/\s*(\d+)/g, m;
    while (m = re.exec(bt)) { var pos = (m[1] === 'D/ST') ? 'DST' : m[1]; roster[pos] = +m[2]; maxes[pos] = +m[3]; }
    return { drafted: SEEN, roster: roster, maxes: (Object.keys(maxes).length ? maxes : MAX), n: Object.keys(SEEN).length, src: 'page scan (practice)', myPlayers: scrapeMyRoster() };
  }

  function state(cb) {
    var lid = lidNow(), tid = teamNow();
    fetch(API + lid + '?view=mDraftDetail', { credentials: 'include' }).then(function (r) { return r.json(); })
      .then(function (d) {
        var picks = (((d.draftDetail || {}).picks) || []).filter(function (p) { return p.playerId > 0; });
        if (picks.length) {
          var drafted = {}, roster = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0 }, byTeam = {}, myPlayers = [];
          picks.forEach(function (p) {
            var mm = BYID[p.playerId]; if (!mm) return; drafted[mm.nl] = 1;
            (byTeam[p.teamId] = byTeam[p.teamId] || []).push(mm);
            if (tid && p.teamId === tid) { roster[mm.pos]++; myPlayers.push({ pos: mm.pos, team: mm.team, nl: mm.nl, name: mm.name, pts: mm.pts, vbd: mm.vbd, adp: mm.adp, pickNo: p.overallPickNumber || p.pickNumber || 0 }); }
          });
          var teamTotals = Object.keys(byTeam).map(function (t) { return startersTotal(byTeam[t]); });
          var mx = scrapeMaxes();
          cb({ drafted: drafted, roster: roster, maxes: (Object.keys(mx).length ? mx : MAX), n: picks.length, src: 'API (live)', myPlayers: myPlayers, teamTotals: teamTotals, myTotal: tid && byTeam[tid] ? startersTotal(byTeam[tid]) : null });
        } else { cb(domState()); }
      }).catch(function () { cb(domState()); });
  }

  function rec(st) {
    var r = st.roster, mx = st.maxes || MAX, round = Math.max(1, Math.ceil((st.n + 1) / 10));
    var qbStart = START.QB + (SUPERFLEX ? OPN : 0), flexCap = START.RB + START.WR + START.TE + FLEXN + OPN;
    var flexOpen = ((r.RB + r.WR + r.TE) < flexCap), pickNo = st.n + 1, nextPick = nextMyPick(pickNo);
    var avail = MODEL.filter(function (p) { return !st.drafted[p.nl]; });
    var supply = { QB: 0, RB: 0, WR: 0, TE: 0 }, tierCount = {};
    avail.forEach(function (p) { if (p.vbd > 0 && supply[p.pos] !== undefined) supply[p.pos]++; var tk = p.pos + '_' + p.tier; tierCount[tk] = (tierCount[tk] || 0) + 1; });
    var bp = seatBlueprint(MYSLOT, LSIZE), wantPos = (bp && round <= bp.length) ? bp[round - 1] : null;
    // v2.15: stacking removed from pick logic — BEST PICK is pure value / need / cliff / schedule.
    return avail.map(function (p) {
      var w = p.vbd, have = r[p.pos] || 0, cap = mx[p.pos] || MAX[p.pos] || 99;
      p.fall = 0; p.steal = '';
      if (have >= cap) { w = -9999; }
      else if (p.pos === 'K') { w = (have === 0 && round >= 13) ? 20 + p.vbd : -9999; }
      else if (p.pos === 'DST') { if (have === 0) { w = (round >= 13) ? 20 + p.vbd : -999; } else { w = p.vbd - 8; } }
      else if (p.pos === 'QB') {
        if (have < qbStart) {
          // v2.1: superflex still wants QB by raw VBD; 1-QB leagues value QB1 over the best QB
          // likely to survive to the next pick — this is the wait-on-QB fix (stops Hurts-in-R5).
          if (SUPERFLEX) { w = p.vbd + 2; }
          else { var qbFloor = expectedAvailPts('QB', nextPick, avail, p); w = (p.pts - qbFloor) + 1; }
        } else { w = (round >= 11) ? p.vbd + 2 : -999; }
      }
      else if (p.pos === 'TE') { if (have < START.TE) { w = (p.vbd >= 3.5) ? p.vbd + 3 : p.vbd; } else { w = p.vbd * 0.5; } }
      else { // RB / WR
        if (have < START[p.pos]) { w = p.vbd + 3; if (p.pos === 'RB' && round <= 5) { w += 1; } } // still need a starter here
        else {
          // v2.2: flex/bench depth — favor whichever of RB/WR is THINNER and discourage stacking the
          // deeper one. Prevents the RB-glut (Entry 4) and the mirror WR-glut. Symmetric on purpose.
          w = p.vbd * (flexOpen ? 0.85 : 0.5);
          var rbD = (r.RB || 0) - START.RB, wrD = (r.WR || 0) - START.WR;
          if (p.pos === 'RB') { if (rbD > wrD) { w *= 0.6; } else if (rbD < wrD) { w += 1.0; } }
          else { if (wrD > rbD) { w *= 0.6; } else if (wrD < rbD) { w += 1.0; } }
        }
      }
      // v2.1 per-seat blueprint nudge: soft lean toward the seat's preferred early-round position
      // when you still need a starter there. Small (+1.1) so steals/clear value still win.
      if (w > -900 && wantPos && p.pos === wantPos && have < (START[p.pos] || 1)) { w += 1.1; }
      // v2.3 strength-of-schedule tilt: capped (+/-SOS_CAP) positional nudge for RB/WR/TE based on how
      // weak their season's opposing defenses are. No-op until sos.json is populated. Never a driver.
      p.sos = 0;
      if (w > -900 && p.team && (p.pos === 'RB' || p.pos === 'WR' || p.pos === 'TE')) {
        var sosTeam = SOSD.teams && SOSD.teams[p.team]; var tl = sosTeam ? (+sosTeam[p.pos] || 0) : 0;
        if (tl) { p.sos = Math.max(-SOS_CAP, Math.min(SOS_CAP, tl)); w += p.sos; }
      }
      // v2.14 positional CLIFF: generalizes the QB wait-cost logic to RB/WR/TE. Weight a candidate up by
      // the projected-points drop from him to the next same-position player likely to survive to your next
      // pick — steep cliff (scarce now, e.g. an RB run) = grab; flat (deep, e.g. WR) = ~0, you can wait.
      p.cliff = 0;
      if (w > -900 && (p.pos === 'RB' || p.pos === 'WR' || p.pos === 'TE')) {
        var drop = p.pts - expectedAvailPts(p.pos, nextPick, avail, p);
        if (drop > 0) { p.cliff = Math.round(drop * 10) / 10; w += Math.min(drop * CLIFF_SCALE, CLIFF_CAP); }
      }
      if (w > -900 && (p.pos === 'QB' || p.pos === 'RB' || p.pos === 'WR' || p.pos === 'TE')) {
        var gap = pickNo - (p.adp || 999);
        if (p.adp <= 110 && gap >= 20) { p.steal = 'STRONG BUY'; w += Math.min(gap, 45) * 0.12; }
        else if (p.adp <= 110 && gap >= 12) { p.steal = 'STEAL'; w += Math.min(gap, 45) * 0.10; }
        else if (gap >= 8) { p.fall = Math.round(gap); w += gap * 0.06; }
        if (p.adp < 999 && (p.adp - pickNo) > 6) { var surv = 1 - normCdf(nextPick, p.adp, p.adp / 4); if (surv >= 0.6) { w -= Math.min(p.adp - pickNo, 60) * 0.06 * surv; } }
        var needStarter = (p.pos === 'QB') ? (have < qbStart) : (have < START[p.pos]);
        if (needStarter) { var s = supply[p.pos]; if (s <= 2) { w += 2; } else if (s <= 5) { w += 1; } if ((tierCount[p.pos + '_' + p.tier] || 9) <= 1) { w += 1.2; } }
      }
      return { p: p, w: Math.round(w * 10) / 10 };
    }).sort(function (a, b) { return b.w - a.w; }).slice(0, 6);
  }

  function planFrom(drafted0, roster0, startPick) {
    if (!MYSLOT || !MYPICKS.length || !MODEL) return [];
    var size = LSIZE || 10, total = size * (ROUNDS || 16), mine = {};
    MYPICKS.forEach(function (p) { mine[p] = 1; });
    var byAdp = MODEL.slice().sort(function (a, b) { return (a.adp || 999) - (b.adp || 999); });
    var drafted = {}; for (var k in drafted0) drafted[k] = 1;
    var R = { QB: roster0.QB || 0, RB: roster0.RB || 0, WR: roster0.WR || 0, TE: roster0.TE || 0, K: roster0.K || 0, DST: roster0.DST || 0 };
    var out = [];
    for (var P = startPick; P <= total && out.length < 8; P++) {
      if (mine[P]) { var top = rec({ drafted: drafted, roster: R, maxes: MAX, n: P - 1 }); var pk = top && top[0] && top[0].p; if (pk) { drafted[pk.nl] = 1; R[pk.pos] = (R[pk.pos] || 0) + 1; out.push({ P: P, pos: pk.pos, name: pk.name }); } }
      else { for (var i = 0; i < byAdp.length; i++) { if (!drafted[byAdp[i].nl]) { drafted[byAdp[i].nl] = 1; break; } } }
    }
    return out;
  }

  function fillSlots(R) {
    var pool = { QB: R.QB, RB: R.RB, WR: R.WR, TE: R.TE, DST: R.DST, K: R.K };
    var out = SLOTS_TPL.map(function (lab) { return { lab: lab, filled: false }; });
    out.forEach(function (sl) { var p = (sl.lab === 'D/ST') ? 'DST' : sl.lab; if (pool[p] !== undefined && pool[p] > 0) { pool[p]--; sl.filled = true; } });
    out.forEach(function (sl) { if (sl.filled) return; var elig = (sl.lab === 'SFLX') ? ['QB', 'RB', 'WR', 'TE'] : (sl.lab === 'FLEX') ? ['RB', 'WR', 'TE'] : []; elig.some(function (p) { if (pool[p] > 0) { pool[p]--; sl.filled = true; return true; } }); });
    return out;
  }

  var panel = document.createElement('div'); panel.id = 'dcp';
  panel.style.cssText = 'position:fixed;top:64px;right:12px;width:308px;background:#0b162a;color:#fff;font:13px/1.45 Arial,sans-serif;z-index:2147483647;border:1px solid #2a3b5a;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.5)';
  panel.innerHTML = '<div id="dcphdr" title="Drag to move" style="padding:8px 10px;background:#16407a;font-weight:bold;border-radius:8px 8px 0 0;cursor:move;user-select:none">⠿ ⚡ Draft Co-Pilot <span style="font-weight:normal;font-size:10px;color:#9bc0ff">v' + VERSION + '</span><span id="dcpx" style="float:right;cursor:pointer">✕</span></div><div id="dcpb" style="padding:10px;max-height:72vh;overflow:auto">Detecting contest…</div>';
  document.body.appendChild(panel);
  document.getElementById('dcpx').onclick = function () { panel.style.display = 'none'; };

  // v2.5: drag the panel anywhere by its header; remember where you put it across refreshes.
  (function makeDraggable() {
    var hdr = document.getElementById('dcphdr');
    try { var p = JSON.parse(localStorage.getItem('dcp_pos') || 'null'); if (p && p.left != null) { panel.style.left = p.left + 'px'; panel.style.top = p.top + 'px'; panel.style.right = 'auto'; } } catch (e) { }
    var drag = false, sx = 0, sy = 0, ox = 0, oy = 0;
    hdr.addEventListener('mousedown', function (e) {
      if (e.target && e.target.id === 'dcpx') return;
      var r = panel.getBoundingClientRect(); ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      panel.style.right = 'auto'; panel.style.left = ox + 'px'; panel.style.top = oy + 'px';
      drag = true; e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!drag) return;
      var nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy);
      nx = Math.max(0, Math.min(window.innerWidth - 60, nx));
      ny = Math.max(0, Math.min(window.innerHeight - 30, ny));
      panel.style.left = nx + 'px'; panel.style.top = ny + 'px';
    });
    document.addEventListener('mouseup', function () {
      if (!drag) return; drag = false;
      try { localStorage.setItem('dcp_pos', JSON.stringify({ left: parseInt(panel.style.left, 10), top: parseInt(panel.style.top, 10) })); } catch (e) { }
    });
  })();

  function render() {
    if (!MODEL) return;
    state(function (st) {
      var top = rec(st), b = document.getElementById('dcpb'); if (!b) return;
      var steals = MODEL.filter(function (p) { return !st.drafted[p.nl] && p.steal; }).sort(function (a, b2) { return (st.n + 1 - a.adp) - (st.n + 1 - b2.adp); });
      var bestSteal = steals.length ? steals[steals.length - 1] : null;
      var plan = planFrom(st.drafted, st.roster, st.n + 1);
      var SL = fillSlots(st.roster);
      var grid = SL.map(function (o) { return '<span style="display:inline-block;margin:2px 3px 2px 0;padding:3px 7px;border-radius:5px;font-size:11px;' + (o.filled ? 'background:#13351f;border:1px solid #1f6b3a;color:#9fe6b6;' : 'background:#1a2336;border:1px dashed #3a4a66;color:#7b8aa6;') + '">' + o.lab + (o.filled ? ' ✓' : '') + '</span>'; }).join('');
      var gaps = SL.filter(function (o) { return !o.filled; }).map(function (o) { return o.lab; });
      var startersN = SLOTS_TPL.length;
      var g = (st.myPlayers && st.myPlayers.length >= startersN) ? gradeRoster(st) : null;

      var h = '<div style="font-size:11px;color:#9bb;margin-bottom:3px">Contest: ' + CONTEST + (MYSLOT ? ' • seat ' + MYSLOT + '/' + LSIZE : '') + '</div>';
      h += '<div style="font-size:11px;color:#9bb;margin-bottom:6px">' + st.src + ' • ' + st.n + ' picks in • injuries ' + (ADJ.updated || 'n/a') + '</div>';
      if (g) {
        var done = st.myPlayers.length >= (ROUNDS || 16);
        h += '<div style="margin-bottom:7px;padding:7px 9px;background:#0e2a1a;border:1px solid #2f7d4f;border-radius:6px">';
        h += '<span style="font-weight:bold;color:#9fe6b6;font-size:15px">My grade: ' + g.letter + '</span><span style="color:#9bb;font-size:11px"> (' + g.score + '/100' + (done ? '' : ', in progress') + ')</span>';
        h += '<div style="font-size:11px;color:#bcd;margin-top:2px">' + (g.rank ? 'starters rank #' + g.rank + ' of ' + g.teams + ' • ' : '') + 'proj starter pts ' + g.starterTot + (g.steals ? ' • ' + g.steals + ' steal(s)' : '') + (g.bal ? ' • balanced' : ' • imbalanced') + '</div>';
        if (g.reaches || g.earlyQB) { h += '<div style="font-size:11px;color:#ff8a8a;margin-top:1px">' + [g.reaches ? g.reaches + ' reach(es)' : '', g.earlyQB ? 'early QB spend' : ''].filter(Boolean).join(' • ') + '</div>'; }
        h += '</div>';
      }
      if (bestSteal) { h += '<div style="margin-bottom:7px;padding:6px 8px;background:#3a1d0a;border:1px solid #d2691e;border-radius:6px"><span style="color:#ffb060;font-weight:bold">🔥 ' + bestSteal.steal + ': ' + bestSteal.pos + ' ' + bestSteal.name + '</span><div style="font-size:11px;color:#e7c39a">ADP ' + Math.round(bestSteal.adp) + ', still here at ' + (st.n + 1) + ' — grab him</div></div>'; }
      var bpSeq = seatBlueprint(MYSLOT, LSIZE), curRound = Math.max(1, Math.ceil((st.n + 1) / (LSIZE || 10)));
      if (bpSeq && MYSLOT) {
        var bpHtml = bpSeq.map(function (pos, i) { var cur = (i + 1) === curRound; return '<span style="display:inline-block;margin:1px 2px;padding:1px 5px;border-radius:4px;font-size:11px;' + (cur ? 'background:#16407a;color:#cfe3ff;font-weight:bold;' : 'background:#1a2336;color:#7b8aa6;') + '">R' + (i + 1) + ' ' + pos + '</span>'; }).join('');
        h += '<div style="margin-bottom:7px;padding:6px 7px;background:#101b30;border:1px solid #24344f;border-radius:6px"><div style="color:#cfe3ff;font-weight:bold;margin-bottom:3px">Seat ' + MYSLOT + '/' + LSIZE + ' blueprint</div><div>' + bpHtml + '</div></div>';
      }
      if (plan.length) { h += '<div style="margin-bottom:7px;padding:6px 7px;background:#101b30;border:1px solid #24344f;border-radius:6px"><div style="color:#cfe3ff;font-weight:bold;margin-bottom:2px">Plan' + (MYSLOT ? ' — seat ' + MYSLOT : '') + ' (rest of draft)</div><div style="font-size:11px;color:#9fb4d6">' + plan.map(function (x) { return 'p' + x.P + ' ' + x.pos; }).join(' · ') + '</div></div>'; }
      h += '<div style="margin-bottom:4px"><b>Your lineup</b></div><div style="margin-bottom:7px">' + grid + '</div>';
      h += '<div style="margin-bottom:9px;color:#ffd24a">Gaps: ' + (gaps.length ? gaps.join(', ') : 'lineup full') + '</div>';
      // v2.4 color-code: green = strong value in YOUR scoring AND fills a need (helps you win + roster fit);
      // yellow = either value or need but not both; red = poor fit (position full, reach, or low relative value).
      // o.w already bakes in this league's scoring (VBD from league-scored projections) + need + steals.
      var bestW = (top[0] && top[0].w) || 1;
      var flexCapC = START.RB + START.WR + START.TE + FLEXN + OPN;
      var flexOpenC = ((st.roster.RB + st.roster.WR + st.roster.TE) < flexCapC);
      function pickColor(o) {
        var p = o.p, have = st.roster[p.pos] || 0, capP = (st.maxes && st.maxes[p.pos]) || MAX[p.pos] || 99;
        if (have >= capP) return '#b5462f';                       // position full -> red
        if (p.steal) return '#1f9d52';                            // a steal is always a green
        var startNeed = (p.pos === 'QB') ? (have < (START.QB + (SUPERFLEX ? OPN : 0))) : (have < (START[p.pos] || 1));
        var need = startNeed || ((p.pos === 'RB' || p.pos === 'WR' || p.pos === 'TE') && flexOpenC);
        var strong = o.w >= 0.6 * bestW;
        if (need && strong) return '#1f9d52';                     // green
        if (need || strong) return '#d9b54a';                     // yellow
        return '#b5462f';                                          // red
      }
      h += '<div style="font-weight:bold;color:#7CFC9A;margin-bottom:3px">BEST PICK ▼</div>';
      h += '<div style="font-size:10px;color:#9bb;margin-bottom:5px">🟢 wins + fills a need · 🟡 value or need · 🔴 poor fit / reach — all scored in <b>your</b> league</div>';
      top.forEach(function (o, i) {
        var flagHtml = o.p.flag ? (o.p.boost ? '<div style="font-size:11px;color:#7CFC9A">↑ ' + o.p.flag + '</div>' : '<div style="font-size:11px;color:#ff8a8a">⚠ ' + o.p.flag + '</div>') : '';
        var tag = o.p.steal ? '<div style="font-size:11px;color:#ffb060">🔥 ' + o.p.steal + ' — ADP ' + Math.round(o.p.adp) + '</div>' : ((o.p.fall && o.p.fall >= 8) ? '<div style="font-size:11px;color:#7fd9ff">📉 value — slid ' + o.p.fall + ' past ADP</div>' : '');
        var sosTag = (o.p.sos && Math.abs(o.p.sos) >= 0.4) ? '<div style="font-size:11px;color:' + (o.p.sos > 0 ? '#7CFC9A">🗓 easy schedule' : '#ff8a8a">🗓 tough schedule') + ' (' + (o.p.sos > 0 ? '+' : '') + o.p.sos.toFixed(1) + ')</div>' : '';
        var cliffTag = (o.p.cliff && o.p.cliff >= 2) ? '<div style="font-size:11px;color:#ffb060">⛰ position thinning — −' + o.p.cliff.toFixed(1) + ' to your next ' + o.p.pos + '</div>' : '';
        var edge = edgeTag(o.p); var edgeHtml = edge ? '<div style="font-size:11px;color:#7fd9ff">' + edge + '</div>' : '';
        // v2.16 consensus draft round from live ADP (expert/field placement). Green ↓ = slipped past it = value.
        var advR = (o.p.adp && o.p.adp < 999) ? Math.ceil(o.p.adp / (LSIZE || 10)) : 0;
        var advBadge = advR ? '<span style="font-size:10px;margin-left:5px;color:' + (curRound > advR ? '#7CFC9A' : '#9bb') + '">· exp R' + advR + (curRound > advR ? ' ↓' : '') + '</span>' : '';
        var col = pickColor(o);
        var bg = (i === 0 ? 'background:#13351f;' : 'background:#0f1828;');
        h += '<div style="padding:5px 7px;border-radius:5px;margin-bottom:3px;border-left:5px solid ' + col + ';' + bg + '"><b>' + o.p.pos + '</b> ' + o.p.name + advBadge + '<span style="float:right;color:#9bb">+' + o.p.vbd + '</span>' + flagHtml + tag + sosTag + cliffTag + edgeHtml + '</div>';
      });
      // v2.15 TRIPLE-STACK alert (the one stack feature kept): 3+ skill players (QB/RB/WR/TE) from one team
      // → "you unlocked a stack" banner + a British shout-out, once per team. Best in real drafts (clean roster read).
      var skillByTeam = {};
      (st.myPlayers || []).forEach(function (mp) { if (mp.team && (mp.pos === 'QB' || mp.pos === 'RB' || mp.pos === 'WR' || mp.pos === 'TE')) skillByTeam[mp.team] = (skillByTeam[mp.team] || 0) + 1; });
      var triples = Object.keys(skillByTeam).filter(function (t) { return skillByTeam[t] >= 3; });
      triples.forEach(function (t) { if (!announcedStacks[t]) { announcedStacks[t] = 1; sayTripleStack(t); } });
      if (triples.length) { h += '<div style="margin-bottom:7px;padding:8px 10px;background:linear-gradient(90deg,#5b21b6,#8a5cd0);color:#fff;font-weight:bold;border-radius:6px;text-align:center;letter-spacing:.5px">🎉 STACK UNLOCKED — ' + triples.map(function (t) { return t + ' ×' + skillByTeam[t]; }).join(' · ') + ' 🎉</div>'; }
      // v2.13 reference: top stacks from LIVE 2026 rosters (each team's real QB + top pass-catchers).
      var refStacks = computeTopStacks();
      if (refStacks.length) {
        h += '<div style="font-weight:bold;color:#c9a0ff;margin:9px 0 3px">📋 TOP 2026 STACKS<span style="font-weight:normal;font-size:10px;color:#9bb"> · live rosters</span></div>';
        refStacks.forEach(function (s, i) {
          var qbN = s.players[0].name, restN = s.players.slice(1).map(function (p) { return p.name; }).join(' + ');
          h += '<div style="padding:4px 7px;margin-bottom:3px;border-left:5px solid #6d4aa0;background:#241636;border-radius:5px"><span style="color:#fff;font-weight:bold">' + (i + 1) + '. ' + s.team + '</span> <span style="color:#d9c6f5">' + qbN + ' + ' + restN + '</span></div>';
        });
      }
      b.innerHTML = h;
    });
  }

  loadAdjustments(function () { loadSos(function () { loadStacks(function () { detectSettings(function () { buildModel(function () { render(); setInterval(render, 5000); }); }); }); }); });
})();
