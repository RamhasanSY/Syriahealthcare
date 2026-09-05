(function () {
  "use strict";

  var lang = localStorage.getItem("shc-lang") === "ar" ? "ar" : "en";
  var news = [];
  var jobs = [];
  var activeTopic = "all";

  var TOPIC_LABELS = {
    all: { en: "All", ar: "الكل" },
    hospitals: { en: "Hospitals & clinics", ar: "المشافي والعيادات" },
    "public-health": { en: "Public health", ar: "الصحة العامة" },
    aid: { en: "Aid & funding", ar: "الإغاثة والتمويل" },
    workforce: { en: "Workforce", ar: "الكوادر الصحية" },
    policy: { en: "Policy", ar: "السياسات" },
    other: { en: "Other", ar: "أخرى" }
  };

  function t(obj, key) {
    if (!obj) return "";
    return obj[key + "_" + lang] || obj[key + "_en"] || obj[key] || "";
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function formatDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString(lang === "ar" ? "ar" : "en-GB", {
      day: "numeric", month: "short", year: "numeric"
    });
  }

  function applyStaticText() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    document.body.dir = lang === "ar" ? "rtl" : "ltr";
    var nodes = document.querySelectorAll("[data-en]");
    for (var i = 0; i < nodes.length; i++) {
      var v = nodes[i].getAttribute("data-" + lang);
      if (v) nodes[i].textContent = v;
    }
    var btn = document.getElementById("langToggle");
    btn.textContent = lang === "ar" ? "English" : "العربية";
    btn.lang = lang === "ar" ? "en" : "ar";
  }

  function renderStamp(updated) {
    var stamp = document.getElementById("stamp");
    if (!updated) { stamp.textContent = ""; return; }
    var when = formatDate(updated);
    stamp.textContent = lang === "ar" ? "آخر تحديث: " + when : "Last updated " + when;
  }

  function renderFilters() {
    var box = document.getElementById("newsFilters");
    box.textContent = "";
    var present = ["all"];
    news.forEach(function (n) {
      if (n.topic && present.indexOf(n.topic) === -1) present.push(n.topic);
    });
    if (present.length < 3) return;
    present.forEach(function (topic) {
      var label = TOPIC_LABELS[topic] ? TOPIC_LABELS[topic][lang] : topic;
      var b = el("button", null, label);
      b.type = "button";
      b.setAttribute("aria-pressed", topic === activeTopic ? "true" : "false");
      b.addEventListener("click", function () {
        activeTopic = topic;
        renderFilters();
        renderNews();
      });
      box.appendChild(b);
    });
  }

  function renderNews() {
    var list = document.getElementById("newsList");
    var empty = document.getElementById("newsEmpty");
    list.textContent = "";
    var items = news.filter(function (n) {
      return activeTopic === "all" || n.topic === activeTopic;
    });
    empty.hidden = items.length > 0;

    items.forEach(function (n) {
      var li = el("li");

      var meta = el("div", "card-meta");
      if (n.topic) {
        var label = TOPIC_LABELS[n.topic] ? TOPIC_LABELS[n.topic][lang] : n.topic;
        meta.appendChild(el("span", "topic", label));
      }
      if (n.source) meta.appendChild(el("span", null, n.source));
      if (n.published) meta.appendChild(el("span", null, formatDate(n.published)));
      li.appendChild(meta);

      var h3 = el("h3", "card-title");
      var a = el("a", null, t(n, "title"));
      a.href = n.url;
      a.rel = "noopener noreferrer";
      a.target = "_blank";
      h3.appendChild(a);
      li.appendChild(h3);

      var summary = t(n, "summary");
      if (summary) li.appendChild(el("p", "card-summary", summary));

      list.appendChild(li);
    });
  }

  function renderJobs() {
    var list = document.getElementById("jobsList");
    var empty = document.getElementById("jobsEmpty");
    list.textContent = "";
    empty.hidden = jobs.length > 0;

    jobs.forEach(function (j) {
      var li = el("li");

      var h3 = el("h3", "job-title");
      var a = el("a", null, t(j, "title"));
      a.href = j.url;
      a.rel = "noopener noreferrer";
      a.target = "_blank";
      h3.appendChild(a);
      li.appendChild(h3);

      var bits = [];
      if (j.organisation) bits.push(j.organisation);
      if (j.location) bits.push(j.location);
      var meta = el("p", "job-meta", bits.join(" · "));
      if (j.deadline) {
        var d = el("span", "job-deadline",
          (lang === "ar" ? " — آخر موعد: " : " — closes ") + formatDate(j.deadline));
        meta.appendChild(d);
      }
      li.appendChild(meta);

      list.appendChild(li);
    });
  }

  function renderAll(updated) {
    applyStaticText();
    renderStamp(updated);
    renderFilters();
    renderNews();
    renderJobs();
  }

  function load() {
    var updated = null;
    Promise.all([
      fetch("data/news.json?" + Date.now()).then(function (r) { return r.json(); }).catch(function () { return {}; }),
      fetch("data/jobs.json?" + Date.now()).then(function (r) { return r.json(); }).catch(function () { return {}; })
    ]).then(function (res) {
      news = (res[0] && res[0].items) || [];
      jobs = (res[1] && res[1].items) || [];
      updated = (res[0] && res[0].updated) || null;
      renderAll(updated);
    });

    document.getElementById("langToggle").addEventListener("click", function () {
      lang = lang === "ar" ? "en" : "ar";
      localStorage.setItem("shc-lang", lang);
      renderAll(updated);
    });
  }

  load();
})();
