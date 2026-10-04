const CFG = {
  tz: 7,
  minSnaps: 3,
  sims: 3000,
  historyWeight: 0.15,
  noSignalThreshold: 0.36,
  sessions: {
    morning: { name: "Morning", start: 600, cutoff: 690, target: 721 },
    afternoon: { name: "Afternoon", start: 840, cutoff: 935, target: 970 }
  }
};

const $ = (id) => document.getElementById(id);
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const timeText = (minutes) =>
  String(Math.floor(minutes / 60)).padStart(2, "0") + ":" +
  String(Math.floor(minutes % 60)).padStart(2, "0");

function thaiNow() {
  const d = new Date(Date.now() + CFG.tz * 60 * 60 * 1000);
  return {
    date: d.toISOString().slice(0, 10),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60,
    clock: d.toISOString().slice(11, 19)
  };
}

function sessionName(minutes) {
  return minutes < 751 ? "morning" : "afternoon";
}

function setDigit(value) {
  return ((Math.round(value * 100) % 10) + 10) % 10;
}

function valueDigit(value) {
  return ((Math.floor(value) % 10) + 10) % 10;
}

let db;

const openDb = indexedDB.open("set-predictor-db", 1);

openDb.onupgradeneeded = (event) => {
  const database = event.target.result;
  database.createObjectStore("snapshots", { autoIncrement: true });
  database.createObjectStore("predictions", { keyPath: "id" });
  database.createObjectStore("actuals", { keyPath: "id" });
};

openDb.onsuccess = (event) => {
  db = event.target.result;
  init();
};

function objectStore(name, mode = "readonly") {
  return db.transaction(name, mode).objectStore(name);
}

function getAll(name) {
  return new Promise((resolve) => {
    const request = objectStore(name).getAll();
    request.onsuccess = () => resolve(request.result);
  });
}

function save(name, item) {
  return new Promise((resolve) => {
    const request = objectStore(name, "readwrite").put(item);
    request.onsuccess = () => resolve();
  });
}

async function currentSnapshots() {
  const now = thaiNow();
  const session = sessionName(now.minutes);
  const cutoff = CFG.sessions[session].cutoff;
  const all = await getAll("snapshots");

  return all
    .filter((item) =>
      item.date === now.date &&
      item.session === session &&
      item.minutes <= cutoff
    )
    .sort((a, b) => a.minutes - b.minutes);
}

async function addSnapshot(set, value, source) {
  if (!(set > 0) || !(value > 0)) {
    alert("SET နဲ့ Value ကို မှန်ကန်စွာထည့်ပါ");
    return;
  }

  const now = thaiNow();

  await save("snapshots", {
    date: now.date,
    session: sessionName(now.minutes),
    minutes: now.minutes,
    set,
    value,
    source
  });

  showSnapshots();
}

function addManual() {
  const set = parseFloat($("inSet").value);
  const value = parseFloat($("inVal").value);

  addSnapshot(set, value, "manual");

  $("inSet").value = "";
  $("inVal").value = "";
}

async function showSnapshots() {
  const data = await currentSnapshots();
  const latest = data[data.length - 1];

  $("snapInfo").textContent = latest
    ? `Snapshots: ${data.length} | Last ${timeText(latest.minutes)} | SET ${latest.set} | Value ${latest.value}`
    : "Snapshot မရှိသေး";
}

function randomNormal() {
  let u = 0;
  let v = 0;

  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();

  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function lineModel(points, key, minutesAhead) {
  const xs = points.map((p) => p.minutes);
  const ys = points.map((p) => p[key]);
  const xMean = mean(xs);
  const yMean = mean(ys);

  let numerator = 0;
  let denominator = 0;

  xs.forEach((x, i) => {
    numerator += (x - xMean) * (ys[i] - yMean);
    denominator += (x - xMean) ** 2;
  });

  const slope = denominator ? numerator / denominator : 0;
  const last = ys[ys.length - 1];

  let errorSum = 0;
  let count = 0;

  for (let i = 1; i < ys.length; i++) {
    const deltaTime = xs[i] - xs[i - 1];

    if (deltaTime > 0) {
      const residual = ys[i] - ys[i - 1] - slope * deltaTime;
      errorSum += (residual * residual) / deltaTime;
      count += 1;
    }
  }

  const noise = count ? Math.sqrt(errorSum / count) : 0.0001;

  return {
    slope,
    center: last + slope * minutesAhead,
    spread: Math.max(noise * Math.sqrt(minutesAhead), 0.0001)
  };
}

function simulatedDistribution(model, digitFunction) {
  const counts = Array(10).fill(0);

  for (let i = 0; i < CFG.sims; i++) {
    const simulatedValue = model.center + model.spread * randomNormal();
    counts[digitFunction(simulatedValue)] += 1;
  }

  return counts.map((count) => count / CFG.sims);
}

async function historicalDistribution(session, key, digitFunction) {
  const actuals = await getAll("actuals");
  const relevant = actuals.filter(
    (item) => item.session === session && item[key] > 0
  );

  const counts = Array(10).fill(1);

  relevant.forEach((item) => {
    counts[digitFunction(item[key])] += 1;
  });

  const total = counts.reduce((a, b) => a + b, 0);
  return counts.map((count) => count / total);
}

function mixDistributions(live, history) {
  return live.map(
    (value, i) =>
      value * (1 - CFG.historyWeight) +
      history[i] * CFG.historyWeight
  );
}

function topThree(probabilities) {
  const digits = [...probabilities.keys()]
    .sort((a, b) => probabilities[b] - probabilities[a])
    .slice(0, 3);

  return {
    digits,
    probability: digits.reduce((sum, digit) => sum + probabilities[digit], 0)
  };
}

async function runPredict() {
  const points = await currentSnapshots();

  if (points.length < CFG.minSnaps) {
    $("pred").innerHTML =
      `<p>Snapshot အနည်းဆုံး ${CFG.minSnaps} ခု လိုပါတယ်။ လက်ရှိ ${points.length} ခုရှိပါတယ်။</p>`;
    return;
  }

  const now = thaiNow();
  const session = sessionName(now.minutes);
  const config = CFG.sessions[session];

  const minutesAhead = Math.max(
    config.target - points[points.length - 1].minutes,
    1
  );

  const setModel = lineModel(points, "set", minutesAhead);
  const valueModel = lineModel(points, "value", minutesAhead);

  const setLive = simulatedDistribution(setModel, setDigit);
  const valueLive = simulatedDistribution(valueModel, valueDigit);

  const setHistory = await historicalDistribution(session, "set", setDigit);
  const valueHistory = await historicalDistribution(session, "value", valueDigit);

  const setProbabilities = mixDistributions(setLive, setHistory);
  const valueProbabilities = mixDistributions(valueLive, valueHistory);

  const setTop = topThree(setProbabilities);
  const valueTop = topThree(valueProbabilities);

  const prediction = {
    id: `${now.date}_${session}`,
    date: now.date,
    session,
    createdAt: now.clock,
    snapshots: points.length,
    set: {
      center: setModel.center,
      low: setModel.center - 1.645 * setModel.spread,
      high: setModel.center + 1.645 * setModel.spread,
      direction: setModel.slope > 0 ? "▲ Up" : setModel.slope < 0 ? "▼ Down" : "■ Flat",
      top: setTop.digits,
      probability: setTop.probability,
      probabilities: setProbabilities
    },
    value: {
      center: valueModel.center,
      low: valueModel.center - 1.645 * valueModel.spread,
      high: valueModel.center + 1.645 * valueModel.spread,
      pace: valueModel.slope,
      top: valueTop.digits,
      probability: valueTop.probability,
      probabilities: valueProbabilities
    },
    combinedProbability: setTop.probability * valueTop.probability
  };

  prediction.signal =
    setTop.probability >= CFG.noSignalThreshold ||
    valueTop.probability >= CFG.noSignalThreshold;

  await save("predictions", prediction);
  renderPrediction(prediction);
}

function probabilityBars(probabilities, top) {
  return probabilities
    .map(
      (p, digit) => `
      <div style="display:flex;align-items:center;gap:6px;margin:3px 0">
        <b style="width:16px;color:${top.includes(digit) ? "#60a5fa" : "#9ca3af"}">${digit}</b>
        <div class="bar" style="width:${Math.min(p * 250, 80).toFixed(0)}%"></div>
        <span class="muted">${(p * 100).toFixed(1)}%</span>
      </div>`
    )
    .join("");
}

function renderPrediction(result) {
  const confidence = (probability) =>
    Math.max(0, ((probability - 0.30) / 0.70) * 100).toFixed(0);

  $("pred").innerHTML = `
    <p class="muted">${result.date} ${CFG.sessions[result.session].name} | ${result.createdAt} | Snapshots ${result.snapshots}</p>
    ${result.signal ? "" : '<p style="color:#fbbf24">⚠ No strong signal — random baseline နဲ့ မကွာပါ</p>'}

    <h2>SET ${result.set.direction}</h2>
    <p>Center ${result.set.center.toFixed(2)} | Range ${result.set.low.toFixed(2)} – ${result.set.high.toFixed(2)}</p>
    <div class="big">${result.set.top.join("")}</div>
    <p class="muted">Top-3 probability ${(result.set.probability * 100).toFixed(1)}% | Baseline 30% | Confidence ${confidence(result.set.probability)}%</p>
    ${probabilityBars(result.set.probabilities, result.set.top)}

    <h2 style="margin-top:14px">Value</h2>
    <p>Center ${result.value.center.toFixed(3)} | Range ${result.value.low.toFixed(3)} – ${result.value.high.toFixed(3)}</p>
    <div class="big">${result.value.top.join("")}</div>
    <p class="muted">Top-3 probability ${(result.value.probability * 100).toFixed(1)}% | Baseline 30% | Confidence ${confidence(result.value.probability)}%</p>
    ${probabilityBars(result.value.probabilities, result.value.top)}

    <p>Combined probability ${(result.combinedProbability * 100).toFixed(1)}% | Random baseline 9%</p>
  `;
}

async function saveActual() {
  const set = parseFloat($("acSet").value);
  const value = parseFloat($("acVal").value);

  if (!(set > 0) || !(value > 0)) {
    alert("Actual SET နဲ့ Value ထည့်ပါ");
    return;
  }

  const now = thaiNow();
  const session = sessionName(now.minutes);

  await save("actuals", {
    id: `${now.date}_${session}`,
    date: now.date,
    session,
    set,
    value
  });

  $("acSet").value = "";
  $("acVal").value = "";

  showStats();
}

async function showStats() {
  const predictions = await getAll("predictions");
  const actuals = await getAll("actuals");
  const actualMap = Object.fromEntries(actuals.map((a) => [a.id, a]));

  let sessions = 0;
  let setHits = 0;
  let valueHits = 0;
  let rows = "";

  predictions
    .sort((a, b) => b.id.localeCompare(a.id))
    .forEach((prediction) => {
      const actual = actualMap[prediction.id];
      if (!actual) return;

      sessions += 1;

      const actualSetDigit = setDigit(actual.set);
      const actualValueDigit = valueDigit(actual.value);
      const setHit = prediction.set.top.includes(actualSetDigit);
      const valueHit = prediction.value.top.includes(actualValueDigit);

      if (setHit) setHits += 1;
      if (valueHit) valueHits += 1;

      rows += `
        <tr>
          <td>${prediction.date} ${prediction.session[0].toUpperCase()}</td>
          <td>${prediction.set.top.join("")} → ${actualSetDigit} ${setHit ? "✅" : "❌"}</td>
          <td>${prediction.value.top.join("")} → ${actualValueDigit} ${valueHit ? "✅" : "❌"}</td>
        </tr>`;
    });

  $("stats").innerHTML = sessions
    ? `
      <p>Sessions ${sessions} | SET hit ${((setHits / sessions) * 100).toFixed(0)}% | Value hit ${((valueHits / sessions) * 100).toFixed(0)}% | Baseline 30%</p>
      ${sessions < 20 ? '<p class="muted">Session 20–30 မပြည့်သေးပါ။ ရလဒ်ကို မယုံကြည်သေးပါနဲ့။</p>' : ""}
      <table>
        <tr><th>Session</th><th>SET</th><th>Value</th></tr>
        ${rows}
      </table>`
    : '<p class="muted">Actual result မရှိသေး</p>';
}

async function exportData() {
  const backup = {
    version: 1,
    snapshots: await getAll("snapshots"),
    predictions: await getAll("predictions"),
    actuals: await getAll("actuals")
  };

  const file = new Blob([JSON.stringify(backup)], {
    type: "application/json"
  });

  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = `set-predictor-${thaiNow().date}.json`;
  link.click();
}

async function importData(input) {
  const file = input.files[0];
  if (!file) return;

  const backup = JSON.parse(await file.text());

  for (const item of backup.snapshots || []) {
    await save("snapshots", item);
  }

  for (const item of backup.predictions || []) {
    await save("predictions", item);
  }

  for (const item of backup.actuals || []) {
    await save("actuals", item);
  }

  alert("Import ပြီးပါပြီ");
  showSnapshots();
  showStats();
}

function tick() {
  const now = thaiNow();
  const session = sessionName(now.minutes);
  const config = CFG.sessions[session];
  const minutes = now.minutes;

  $("clock").textContent =
    `Thailand ${now.date} ${now.clock} (UTC+7)`;

  $("sess").textContent =
    `${config.name}: Live ${timeText(config.start)}–${timeText(config.cutoff)} | Predict ${timeText(config.cutoff)} | Target ${timeText(config.target)}`;

  if (minutes < config.start) {
    $("countdown").textContent =
      `Live စရန် ${timeText(config.start - minutes)} လိုပါသေးတယ်`;
  } else if (minutes < config.cutoff) {
    $("countdown").textContent =
      `📡 Data စုနေသည် — Predict အထိ ${timeText(config.cutoff - minutes)}`;
  } else if (minutes < config.target) {
    $("countdown").textContent =
      `🎯 Predict လုပ်ရန် — Target အထိ ${timeText(config.target - minutes)}`;
  } else {
    $("countdown").textContent =
      "✅ Actual result ထည့်ရန်";
  }
}

function init() {
  tick();
  setInterval(tick, 1000);
  showSnapshots();
  showStats();
}
