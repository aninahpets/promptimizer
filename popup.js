(function () {
  "use strict";

  function freshLevers() { return { fidelity: 65, reliability: 55, thoroughness: 50, cost: 50 }; }
  function freshState() {
    return {
      stage: "intake",
      rawAsk: "",
      ctx: { provider: "any" },
      diagnosis: null,
      answers: {},
      freetext: {},
      levers: freshLevers(),
      result: null,
      critique: null,
      error: null
    };
  }
  var state = freshState();
  var nanoStatus = "unknown"; // unknown | ok | downloadable | unavailable

  // Pull a JSON object out of a model reply that may be fenced or carry stray prose.
  function extractJSON(text) {
    if (text == null) return null;
    var t = String(text).trim();
    var fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    try { return JSON.parse(t); } catch (e) {}
    var s = t.indexOf("{"), e2 = t.lastIndexOf("}");
    if (s > -1 && e2 > s) { try { return JSON.parse(t.slice(s, e2 + 1)); } catch (e3) {} }
    return null;
  }

  var STAGES = [
    { id: "intake", lbl: "Your idea" },
    { id: "optimize", lbl: "Your prompt" }
  ];

  // Classic "copy" glyph (two overlapping squares) and a check for the done state.
  var COPY_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>';
  var CHECK_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>';

  var app = document.getElementById("app");
  var rail = document.getElementById("rail");

  // ---------- Persistence (popups are ephemeral — remember where we were) ----------
  function saveState() {
    try { chrome.storage.local.set({ pzState: state }); } catch (e) {}
  }
  function normalize(saved) {
    var s = saved || freshState();
    if (!s.levers) s.levers = freshLevers();
    if (!s.ctx) s.ctx = { provider: "any" };
    if (!s.answers) s.answers = {};
    if (!s.freetext) s.freetext = {};
    // A loader stage means a call was in flight when the popup closed — fall back.
    // (Legacy "diagnosing"/"interview" stages no longer exist — send them home.)
    if (s.stage === "diagnosing" || s.stage === "interview") s.stage = "intake";
    if (s.stage === "synthesizing") s.stage = s.result ? "result" : "intake";
    if (["intake", "result"].indexOf(s.stage) < 0) s.stage = "intake";
    // Guard against a stage whose data didn't survive.
    if (s.stage === "result" && (!s.result || typeof s.result.prompt !== "string")) s.stage = "intake";
    return s;
  }

  // ---------- Model calls ----------
  // Everything runs on-device via Chrome's built-in Prompt API (Gemini Nano):
  // no API key, no network, no backend.
  function callModel(instructions, payload, maxTokens, onStatus) {
    return callLocal(instructions, payload, onStatus);
  }

  // On-device inference via Chrome's built-in Prompt API (Gemini Nano).
  // No key, no network, no context-length worries — each step is a small,
  // self-contained instruction + payload that returns one JSON object.
  var LOCAL_SYSTEM = "You are a precise assistant. Reply with a single valid JSON object and nothing else — no explanation, no markdown, no code fences.";
  async function callLocal(instructions, payload, onStatus) {
    if (typeof LanguageModel === "undefined") {
      throw { code: "no_local", message: "This browser doesn't expose Chrome's built-in AI (Gemini Nano)." };
    }
    var avail;
    try { avail = await LanguageModel.availability(); }
    catch (e) { throw { code: "no_local", message: "Couldn't reach the on-device model." }; }
    if (avail === "unavailable") {
      throw { code: "no_local", message: "Gemini Nano isn't available on this device." };
    }
    var session;
    try {
      session = await LanguageModel.create({
        initialPrompts: [{ role: "system", content: LOCAL_SYSTEM }],
        // Declare language so Chrome can attest output safety (silences the
        // "no output language specified" warning). en | de | es | fr | ja.
        expectedInputs: [{ type: "text", languages: ["en"] }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
        monitor: function (m) {
          m.addEventListener("downloadprogress", function (ev) {
            if (onStatus) onStatus(Math.round((ev.loaded || 0) * 100));
          });
        }
      });
    } catch (e) {
      throw { code: "local_create", message: (e && e.message) || "Couldn't start the on-device model." };
    }
    var input = instructions + "\n\n=== INPUT ===\n" + JSON.stringify(payload, null, 2) + "\n\nReply with ONLY the JSON object.";
    var text;
    try {
      text = await session.prompt(input);
    } catch (e) {
      try { session.destroy(); } catch (_) {}
      throw { code: "local_run", message: (e && e.message) || "The on-device model couldn't finish." };
    }
    try { session.destroy(); } catch (e) {}
    var parsed = extractJSON(text);
    if (!parsed) throw { code: "parse", message: "The on-device model's reply wasn't valid JSON — try again." };
    return parsed;
  }

  // ---------- Helpers ----------
  // Small on-device models don't always honor the schema — coerce anything
  // we're about to .map() over so a loose field degrades instead of crashing.
  function asArray(x) { return Array.isArray(x) ? x : []; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function providerLabel(p) {
    return {
      any: "No preference — recommend the provider and model too",
      openai: "OpenAI (GPT family)",
      anthropic: "Anthropic (Claude family)",
      google: "Google (Gemini family)",
      oss: "Open-source / local models"
    }[p] || "No preference";
  }
  function stageIndex(id) { for (var i = 0; i < STAGES.length; i++) if (STAGES[i].id === id) return i; return 0; }
  function currentRailStage() {
    if (state.stage === "intake") return "intake";
    return "optimize";
  }
  function renderRail() {
    var ci = stageIndex(currentRailStage());
    rail.innerHTML = STAGES.map(function (s, i) {
      var cls = "step" + (i < ci ? " done" : i === ci ? " active" : "");
      return '<div class="' + cls + '"><span class="bar"></span><span class="lbl">' + esc(s.lbl) + "</span></div>";
    }).join("");
  }

  function toast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(t._t); t._t = setTimeout(function () { t.classList.remove("show"); }, 1800);
  }
  function copyText(text) {
    function fallback() { toast("Select the text to copy"); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast("Copied!"); }, fallback);
    } else { fallback(); }
  }
  function saveFile(filename, text) {
    try {
      var blob = new Blob([text], { type: "text/plain" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1200);
    } catch (e) { toast("Couldn't save the file"); }
  }
  // ---------- Model instruction blocks ----------
  var SYNTH = [
    'You are the synthesis engine of "Promptimizer." Produce ONE excellent, ready-to-paste prompt for a non-technical user to give to an AI model.',
    'Balance these objectives explicitly:',
    '- Utility: it should reliably produce output that does the user\'s job.',
    '- Fidelity: faithful to what the user actually asked — never silently substitute a more generic task.',
    '- Cost: no filler; every line earns its place.',
    '- Reliability: enough structure and a clear output contract that results are consistent across runs.',
    '- Sufficient but not prescriptive: give the model the detail and structure it needs, while leaving creative or contextual latitude where over-specifying would hurt the result.',
    'Honor four tuning levers (each 0-100) in HOW you write the prompt and what you recommend:',
    '- fidelity: 0 = explore freely around the ask, 100 = follow the ask literally.',
    '- reliability: 0 = open-ended, 100 = strict structure and a fixed output format.',
    '- thoroughness: 0 = brief prompt and brief expected output, 100 = detailed, comprehensive, covers edge cases and asks for longer output.',
    '- cost: 0 = minimize spend (prefer a cheap, fast, smaller model), 100 = capability over cost (allow the strongest, pricier model). This lever is the PRIMARY driver of the model recommendation.',
    'Scale the prompt to the task and the levers: a brief, low-reliability creative task may be a few sentences; a high-reliability extraction task needs an explicit format. Do not pad.',
    'The prompt text itself must be plain and usable by a non-technical person — clear instructions, no unexplained jargon.',
    'Also recommend the concrete setup to RUN this prompt:',
    '- Recommend a specific, real, current model. Stay within the stated provider; if the preference is "no preference", choose the provider and model you would actually recommend and name both. Let the COST lever primarily decide the capability tier: low cost -> the cheapest model that can do the task well; high cost -> the strongest model. Let high thoroughness or high reliability nudge toward a more capable model within that budget. Do not invent model names.',
    '- Recommend an output length derived from thoroughness, reliability, and the task — not a fixed default. Low thoroughness implies short output; high implies longer.',
    'Return ONLY a JSON object:',
    '{',
    '  "prompt": the finished prompt as a plain string, ready to paste. Do NOT wrap it in code fences.',
    '  "rationale": 3-6 objects { "section": short plain label for a part of the prompt, "why": one friendly sentence, "criterion": one of "utility","fidelity","cost","reliability","latitude" },',
    '  "leftOpen": 1-4 strings — things you deliberately did NOT pin down, and why leaving them open helps the result,',
    '  "estTokens": integer — rough token count of the prompt string itself,',
    '  "costNote": one short, plain sentence on how long/expensive the answers to this prompt will tend to be,',
    '  "recommendation": { "model": the specific model you recommend (include the provider name if the preference was "no preference"), "modelReason": one short plain sentence tying the pick to the budget and provider, "outputLength": a short phrase like "about 150 words" or "short, 1-2 paragraphs", "outputLengthReason": one short plain sentence }',
    '}'
  ].join("\n");

  var CRITIQUE = [
    'You are the friendly reviewer of "Promptimizer." Given a finished prompt, find where it could fall short: unclear bits, ways the AI could follow it but still miss what the user wanted, answers that could come out inconsistent or too long, or missing details.',
    'Be specific and concrete, in plain language. Do not praise. Do not restate the prompt.',
    'Return ONLY a JSON object:',
    '{',
    '  "score": integer 0-100 — how solid the prompt is as written,',
    '  "risks": 2-5 objects { "issue": the concrete weak spot in plain words, "severity": "low"|"med"|"high", "fix": a specific, small change to the prompt that resolves it }',
    '}'
  ].join("\n");

  // ---------- Renderers ----------
  function render() {
    renderRail();
    switch (state.stage) {
      case "intake": renderIntake(); break;
      case "synthesizing": renderLoader("synth"); break;
      case "result": renderResult(); break;
      default: renderIntake();
    }
    saveState();
  }

  function sel(id, val, opts) {
    return '<select id="' + id + '">' + opts.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (o[0] === val ? " selected" : "") + ">" + esc(o[1]) + "</option>";
    }).join("") + "</select>";
  }
  function chip(text) { return '<button class="chip" data-v="' + esc(text) + '">' + esc(text) + "</button>"; }

  function renderIntake() {
    if (nanoStatus === "unavailable") { renderUnsupported(); return; }
    app.innerHTML =
      '<h2 class="title">What do you want the AI to do, in simple terms?</h2>' +
      '<div class="card">' +
        '<textarea id="ask" placeholder="e.g. create a landing page for my website">' + esc(state.rawAsk) + '</textarea>' +
        '<div class="field"><label>Which AI will you use? <span class="hint">— we\'ll recommend the exact model &amp; length</span></label>' +
          sel("provider", state.ctx.provider, [["any","Not sure — recommend one"],["openai","ChatGPT (OpenAI)"],["anthropic","Claude (Anthropic)"],["google","Gemini (Google)"],["oss","Open-source / local"]]) +
        '</div>' +
        '<div class="examples">' +
          '<div class="ex-h">Or try one of these:</div>' +
          '<div class="chips">' +
            chip("Write a warm weekly update from my notes") +
            chip("Sort my customer emails by how urgent they are") +
            chip("Turn a meeting recording into clear notes") +
            chip("Write product descriptions that don\'t sound robotic") +
          '</div>' +
        '</div>' +
        '<div class="actions">' +
          '<button class="btn primary" id="go" disabled>Write my prompt →</button>' +
          '<span class="hintline">' + (nanoStatus === "downloadable" ? "first run downloads a small model, then it\'s instant" : "runs privately on your device") + '</span>' +
        '</div>' +
      '</div>';

    var ta = document.getElementById("ask");
    var go = document.getElementById("go");
    function sync() { go.disabled = ta.value.trim().length < 4; }
    ta.addEventListener("input", function () { state.rawAsk = ta.value; sync(); saveState(); });
    sync(); ta.focus();
    document.getElementById("provider").addEventListener("change", function (e) { state.ctx.provider = e.target.value; saveState(); });
    Array.prototype.forEach.call(app.querySelectorAll(".chip"), function (c) {
      c.addEventListener("click", function () { ta.value = c.dataset.v; state.rawAsk = c.dataset.v; sync(); ta.focus(); saveState(); });
    });
    go.addEventListener("click", function () { startSynth(); });
  }

  // Shown when Chrome's built-in AI isn't available — Nano is the only engine.
  function renderUnsupported() {
    app.innerHTML =
      '<h2 class="title">Promptimizer needs Chrome\'s built-in AI</h2>' +
      '<div class="card"><div class="notice"><b>This browser can\'t run the on-device model yet.</b><br>' +
        'Promptimizer writes your prompts privately with Gemini Nano, Chrome\'s built-in AI. It needs a recent version of Chrome on a supported device.</div>' +
        '<ul class="leftopen" style="margin-top:12px">' +
          '<li>Update Chrome to the latest version.</li>' +
          '<li>If it\'s still off, enable <b>chrome://flags/#prompt-api-for-gemini-nano</b>, then restart Chrome.</li>' +
        '</ul>' +
        '<div class="actions"><button class="btn primary" id="recheck">Check again</button></div>' +
      '</div>';
    document.getElementById("recheck").addEventListener("click", function () { nanoStatus = "unknown"; probeNano(); });
  }

  var LOADER_MSGS = {
    synth: ["reading your idea…", "weighing quality against cost…", "shaping your prompt…", "making it clear and reliable…", "picking the best model for you…", "adding the finishing touches…"]
  };
  function renderLoader(kind) {
    app.innerHTML = '<div class="card"><div class="loader"><div class="dial"></div><div class="lm" id="lm"></div></div></div>';
    var msgs = LOADER_MSGS[kind], i = 0, el = document.getElementById("lm");
    el.textContent = msgs[0];
    clearInterval(app._li);
    app._li = setInterval(function () { i = (i + 1) % msgs.length; if (el) el.textContent = msgs[i]; }, 1700);
  }
  // Take over the loader line with on-device download progress (first local run only).
  function setLoaderStatus(msg) {
    clearInterval(app._li);
    var el = document.getElementById("lm");
    if (el) el.textContent = msg;
  }
  function dlStatus(pct) {
    setLoaderStatus(pct >= 100 ? "setting up the on-device model…" : "downloading the on-device model… " + pct + "%");
  }

  function errorCard(err, retry) {
    var msg = (err && err.message) || "Something went wrong.";
    var code = err && err.code;
    var title = "The on-device model had trouble.";
    var hint = "";
    if (code === "no_local") {
      title = "The on-device model isn't ready.";
      hint = "Make sure you're on a recent Chrome with built-in AI available on this device.";
    } else if (code === "parse") {
      hint = "The model returned something unexpected — trying again usually fixes it.";
    } else if (code === "local_create" || code === "local_run") {
      hint = "Give it another go — the first run also downloads the model, which can take a minute.";
    }
    app.innerHTML =
      '<div class="card"><div class="notice"><b>' + esc(title) + '</b><br>' + esc(msg) + (hint ? "<br>" + esc(hint) : "") +
      '</div><div class="actions">' +
      (retry ? '<button class="btn primary" id="retry">Try again</button>' : "") +
      '<button class="btn ghost" id="back">Start over</button></div></div>';
    if (retry) document.getElementById("retry").addEventListener("click", retry);
    document.getElementById("back").addEventListener("click", function () { state.stage = "intake"; render(); });
  }

  // ---------- Levers ----------
  var LEVER_DEFS = [
    { id: "fidelity", name: "Precision", lo: "Loose", hi: "Exact",
      desc: "How closely the AI sticks to exactly what you asked. Lower lets it reinterpret and add ideas of its own; higher keeps it right on your request." },
    { id: "reliability", name: "Consistency", lo: "Flexible", hi: "Same every time",
      desc: "How alike the results are each time you run it. Lower gives free-form answers that can vary; higher locks in a set structure so every run comes out the same shape." },
    { id: "thoroughness", name: "Detail", lo: "Brief", hi: "In-depth",
      desc: "How much the AI covers. Lower keeps things short and to the point; higher goes deeper with more detail — and usually a longer answer." },
    { id: "cost", name: "Budget", lo: "Save money", hi: "Best quality",
      desc: "How much to spend on the AI model — this mainly decides which model we suggest. Lower picks a cheaper, faster model; higher unlocks the most capable (and pricier) one." }
  ];
  function leverRow(l, idPrefix, dataAttr) {
    var v = state.levers[l.id];
    return '<div class="lever"><div class="ltop"><span class="lname">' + esc(l.name) + '</span>' +
      '<span class="lval" id="' + idPrefix + l.id + '">' + v + '</span></div>' +
      '<input type="range" min="0" max="100" step="5" value="' + v + '" ' + dataAttr + '="' + l.id + '">' +
      '<div class="lends"><span>' + esc(l.lo) + "</span><span>" + esc(l.hi) + "</span></div>" +
      '<div class="ldesc">' + esc(l.desc) + "</div></div>";
  }
  function renderLeversInline() {
    return '<div class="levers">' + LEVER_DEFS.map(function (l) { return leverRow(l, "ilval-", "data-ilever"); }).join("") + "</div>";
  }
  function wireLevers(attr, prefix) {
    Array.prototype.forEach.call(app.querySelectorAll("input[" + attr + "]"), function (r) {
      r.addEventListener("input", function () {
        var id = r.getAttribute(attr);
        state.levers[id] = parseInt(r.value, 10);
        var out = document.getElementById(prefix + id);
        if (out) out.textContent = r.value;
        saveState();
      });
    });
  }

  // ---------- Synthesize ----------
  function assembleAnswers() {
    if (!state.diagnosis) return [];
    return state.diagnosis.questions.map(function (q) {
      var a;
      if (Array.isArray(q.options) && q.options.length === 0) {
        a = state.freetext[q.id] != null && state.freetext[q.id] !== "" ? state.freetext[q.id] : (q.default || "");
      } else {
        a = state.answers[q.id] != null && state.answers[q.id] !== "" ? state.answers[q.id] : (q.default || "");
      }
      return { question: q.question, answer: String(a).replace(/\|/g, ", ") };
    });
  }
  function startSynth(extra) {
    state.stage = "synthesizing"; render();
    var payload = {
      raw_ask: state.rawAsk,
      provider_preference: providerLabel(state.ctx.provider),
      task_type: state.diagnosis ? state.diagnosis.archetype : "general",
      clarifications: assembleAnswers(),
      levers: state.levers
    };
    if (extra && extra.fixes) payload.address_these_known_issues = extra.fixes;
    callModel(SYNTH, payload, 8000, dlStatus).then(function (r) {
      if (!r || typeof r.prompt !== "string") throw { message: "Got an unexpected reply — try again." };
      state.result = r; state.critique = null; state.stage = "result"; render();
    }).catch(function (err) { errorCard(err, function () { startSynth(extra); }); });
  }

  // ---------- Result ----------
  var CRIT_LABEL = { utility: "Useful", fidelity: "On-target", cost: "Cost", reliability: "Consistent", latitude: "Flexible" };

  function renderRecoCard(reco) {
    if (!reco) return "";
    var rows = "";
    if (reco.model) rows += recoRow("Model to use", reco.model, reco.modelReason);
    if (reco.outputLength) rows += recoRow("Answer length", reco.outputLength, reco.outputLengthReason);
    if (!rows) return "";
    return '<div class="card reco"><div class="section-h">What to run it with — matched to your settings</div>' + rows + "</div>";
  }
  function recoRow(label, value, reason) {
    return '<div class="reco-row"><span class="reco-k">' + esc(label) + '</span>' +
      '<span class="reco-v">' + esc(value) + "</span>" +
      (reason ? '<span class="reco-w">' + esc(reason) + "</span>" : "") + "</div>";
  }

  function renderResult() {
    var r = state.result;
    var rationale = asArray(r.rationale).map(function (x) {
      x = x || {};
      var tag = CRIT_LABEL[x.criterion] || (x.criterion || "");
      return '<div class="rat"><span class="rtag">' + esc(tag) + '</span><div><div class="rs">' + esc(x.section) + '</div><div class="rw">' + esc(x.why) + "</div></div></div>";
    }).join("");
    var leftOpen = asArray(r.leftOpen).map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("");

    app.innerHTML =
      '<p class="eyebrow">Step 2 · Your prompt</p>' +
      '<h2 class="title">Here\'s your prompt</h2>' +
      '<div class="card"><div class="promptbox">' +
        '<button class="copybtn" id="copy" type="button" title="Copy prompt" aria-label="Copy prompt">' + COPY_SVG + '</button>' +
        '<pre class="prompt" id="prompttext">' + esc(r.prompt) + "</pre></div>" +
        '<div class="meter">' +
          '<span>Prompt length · <b>~' + esc(r.estTokens != null ? r.estTokens : "—") + '</b> tokens</span>' +
          (r.costNote ? '<span style="min-width:0">' + esc(r.costNote) + "</span>" : "") +
        "</div>" +
        '<div class="actions">' +
          '<button class="btn subtle" id="dl">Save as file</button>' +
          '<button class="btn ghost" id="crit">Check for weak spots</button>' +
        "</div>" +
      "</div>" +
      renderRecoCard(r.recommendation) +
      (rationale ? '<div class="card"><div class="section-h">Why it\'s written this way</div>' + rationale + "</div>" : "") +
      (leftOpen ? '<div class="card"><div class="section-h">Left flexible on purpose</div><ul class="leftopen">' + leftOpen + "</ul></div>" : "") +
      '<div class="card"><div class="section-h">Not quite right? Adjust and rewrite</div>' + renderLeversInline() +
        '<div class="actions"><button class="btn subtle" id="regen">Rewrite with these settings</button>' +
        '<button class="btn ghost" id="fresh">Start fresh</button></div></div>' +
      '<div id="critmount"></div>';

    var copyBtn = document.getElementById("copy");
    copyBtn.addEventListener("click", function () {
      copyText(r.prompt);
      copyBtn.innerHTML = CHECK_SVG; copyBtn.classList.add("ok");
      clearTimeout(copyBtn._t);
      copyBtn._t = setTimeout(function () { copyBtn.innerHTML = COPY_SVG; copyBtn.classList.remove("ok"); }, 1300);
    });
    document.getElementById("dl").addEventListener("click", function () { saveFile("my-prompt.txt", r.prompt); });
    document.getElementById("crit").addEventListener("click", runCritique);
    wireLevers("data-ilever", "ilval-");
    document.getElementById("regen").addEventListener("click", function () { startSynth(); });
    document.getElementById("fresh").addEventListener("click", function () { state = freshState(); render(); });

    if (state.critique) mountCritique(state.critique);
  }

  // ---------- Critique ----------
  function runCritique() {
    var mount = document.getElementById("critmount");
    mount.innerHTML = '<div class="card"><div class="loader"><div class="dial"></div><div class="lm">looking for weak spots…</div></div></div>';
    callModel(CRITIQUE, { prompt: state.result.prompt, raw_ask: state.rawAsk }, 1500)
      .then(function (c) {
        if (!c || !Array.isArray(c.risks)) throw { message: "Got an unexpected reply." };
        state.critique = c; saveState(); mountCritique(c);
      }).catch(function (err) {
        mount.innerHTML = '<div class="card"><div class="notice">Couldn\'t run the check: ' + esc((err && err.message) || "error") + "</div></div>";
      });
  }
  function mountCritique(c) {
    var mount = document.getElementById("critmount");
    var risks = asArray(c.risks).map(function (rk) {
      rk = rk || {};
      var sev = (rk.severity || "med").toLowerCase();
      if (["low", "med", "high"].indexOf(sev) < 0) sev = "med";
      var label = { low: "minor", med: "worth a look", high: "important" }[sev];
      return '<div class="risk"><div class="rhead"><span class="sev ' + sev + '">' + esc(label) + '</span><span class="issue">' + esc(rk.issue) + "</span></div>" +
        '<div class="fix"><b>Try:</b> ' + esc(rk.fix) + "</div></div>";
    }).join("");
    var hasFixes = asArray(c.risks).some(function (rk) { return rk && rk.fix; });
    mount.innerHTML =
      '<div class="card"><div class="section-h">Weak-spot check</div>' +
      '<div class="score"><span class="num">' + esc(c.score != null ? c.score : "—") + '</span><span class="den">out of 100 · how solid it is</span></div>' +
      risks +
      (hasFixes ? '<div class="actions"><button class="btn primary" id="applyfix">Apply these fixes &amp; rewrite</button></div>' : "") +
      "</div>";
    mount.scrollIntoView({ behavior: "smooth", block: "start" });
    if (hasFixes) {
      document.getElementById("applyfix").addEventListener("click", function () {
        var fixes = (c.risks || []).map(function (rk) { return rk.issue + " -> " + rk.fix; });
        startSynth({ fixes: fixes });
      });
    }
  }

  // ---------- Boot ----------
  // Check whether Chrome's built-in model is usable, then reflect it in the UI.
  function probeNano() {
    if (typeof LanguageModel === "undefined") { nanoStatus = "unavailable"; render(); return; }
    LanguageModel.availability().then(function (a) {
      nanoStatus = (a === "unavailable") ? "unavailable" : (a === "available" ? "ok" : "downloadable");
      render();
    }, function () { nanoStatus = "unavailable"; render(); });
  }

  chrome.storage.local.get(["pzState"], function (res) {
    if (res && res.pzState) state = normalize(res.pzState);
    render();
    probeNano();
  });
})();
