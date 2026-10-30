/* Hämtar strömmar från Torrentio via Real-Debrid och sorterar fram de som
   LG C5 faktiskt kan spela. C5 saknar DTS-stöd, så DTS/TrueHD-filer utan
   Dolby-ljudspår sorteras ner. */
var Streams = (function () {
  var BASE = "https://torrentio.strem.fun";

  // Med Real-Debrid-nyckel: färdiga länkar från Real-Debrid. Utan: vanliga torrents
  // som spelas via Stremios torrentserver på Macen (Stremio måste vara igång där).
  function mode() {
    if (Settings.get("realDebridKey")) return "rd";
    if (Settings.get("streamServer")) return "p2p";
    return "";
  }

  function configPath() {
    var key = Settings.get("realDebridKey");
    var opts = ["sort=qualitysize", "qualityfilter=480p,scr,cam,unknown"];
    if (key) opts.push("debridoptions=nodownloadlinks,nocatalog", "realdebrid=" + key);
    return opts.join("|");
  }

  // Samma adress som Stremio själv använder: /<infoHash>/<filindex>?tr=<källor>.
  // Filindex -1 låter servern välja videofilen. De flesta Torrentio-svar saknar trackers,
  // och med bara DHT hittar servern sällan delare – därför läggs några öppna trackers till.
  var TRACKERS = ["udp://tracker.opentrackr.org:1337/announce", "udp://open.demonii.com:1337/announce",
    "udp://exodus.desync.com:6969/announce", "udp://tracker.torrent.eu.org:451/announce", "udp://open.stealth.si:80/announce"];
  function torrentUrl(s) {
    var base = String(Settings.get("streamServer") || "").replace(/\/+$/, "");
    var idx = typeof s.fileIdx === "number" && isFinite(s.fileIdx) ? s.fileIdx : -1;
    var src = ["dht:" + s.infoHash].concat(s.sources || []), seen = {};
    TRACKERS.forEach(function (t) { src.push("tracker:" + t); });
    var tr = src.filter(function (x) { if (seen[x]) return false; seen[x] = 1; return true; })
      .map(function (x) { return "tr=" + encodeURIComponent(x); });
    return base + "/" + encodeURIComponent(s.infoHash) + "/" + idx + "?" + tr.join("&");
  }

  function idFor(item) {
    return item.type === "movie" ? item.id : item.id + ":" + item.season + ":" + item.episode;
  }

  function parse(s) {
    var name = s.name || "";
    var text = (s.description || s.title || "");
    var lines = text.split("\n");
    var file = (s.behaviorHints && s.behaviorHints.filename) || lines[0] || "";
    var all = name + " " + text;
    var res = /2160p|4k|uhd/i.test(all) ? 2160 : /1080p/i.test(all) ? 1080 : /720p/i.test(all) ? 720 : 480;
    var sizeM = all.match(/💾\s*([\d.,]+)\s*(GB|MB)/i);
    var sizeGB = sizeM ? parseFloat(sizeM[1].replace(",", ".")) / (sizeM[2].toUpperCase() === "MB" ? 1024 : 1) : 0;
    var seedM = all.match(/👤\s*(\d+)/);
    var p2p = !s.url && !!s.infoHash;
    var cached = !p2p && (/\[RD\+\]/.test(name) || (/\bRD\b/.test(name) && !/download/i.test(name)));
    var hasDolbyAudio = /\b(DDP?|DD\+|E-?AC-?3|AC-?3|Atmos|AAC|Opus|DD5|DDP5|DD2)\b/i.test(all);
    // LG 2023–2024 (t.ex. G4) spelar DTS; TrueHD utan Dolby-spår undviks ändå
    var hasDts = Settings.get("tvHasDts") ? /TrueHD|\bTHD\b/i.test(all) : /\bDTS(-?HD|-?X|-?MA)?\b|TrueHD|\bTHD\b/i.test(all);
    var badAudio = hasDts && !hasDolbyAudio;
    // Bara riktiga videofiler – allt annat (exe, zip, iso, lnk …) sorteras bort
    var ext = (file.match(/\.([a-z0-9]{2,4})$/i) || [])[1];
    var notVideo = ext && !/^(mkv|mp4|m4v|avi|ts|m2ts|webm|mov)$/i.test(ext);
    var junk = notVideo || /\b(3D|HSBS|H-SBS|ISO|BDMV|COMPLETE\.BLURAY|AVC\.REMUX\.3D)\b/i.test(all) || /\.(iso|rar|zip|exe)\b/i.test(file);
    var hdr = /\bDV\b|Dolby ?Vision|DoVi/i.test(all) ? "Dolby Vision" : /HDR10\+?|\bHDR\b/i.test(all) ? "HDR" : "";
    var remux = /remux/i.test(all);
    var langs = (text.match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu) || []).join(" ");
    return {
      url: p2p ? torrentUrl(s) : s.url, p2p: p2p, binge: (s.behaviorHints && s.behaviorHints.bingeGroup) || "", videoSize: (s.behaviorHints && s.behaviorHints.videoSize) || 0, cached: cached, res: res, sizeGB: sizeGB, seeders: seedM ? +seedM[1] : 0,
      badAudio: badAudio, junk: junk, hdr: hdr, remux: remux, file: file, langs: langs,
      swedish: /🇸🇪|swedish|swe\b|nordic/i.test(all),
      label: (res === 2160 ? "4K" : res + "p") + (hdr ? " " + hdr : "") + (remux ? " Remux" : "")
    };
  }

  function score(st, maxRes) {
    var sc = 0;
    if (st.cached) sc += 1000;
    if (st.res <= maxRes) sc += st.res / 10; else sc -= 500;
    if (st.badAudio) sc -= 800;
    if (st.junk) sc -= 2000;
    // Remuxar på 50–90 GB kan hacka över wifi; föredra rimlig storlek
    if (st.sizeGB > 45) sc -= 150; else if (st.sizeGB > 25) sc -= 40;
    if (st.sizeGB > 0 && st.sizeGB < 0.4) sc -= 100;
    if (st.swedish) sc += 15;
    if (st.p2p) {
      // Torrents: många delare = snabb start; stora filer tar längre tid att komma igång
      sc += Math.min(st.seeders, 50) * 2;
      if (st.seeders < 5) sc -= 600;
      if (st.sizeGB > 20) sc -= 200;
    }
    return sc;
  }

  function fetchFor(item) {
    var m = mode();
    if (!m) return Promise.reject(new Error("Lägg in Real-Debrid-nyckel eller torrentserver under Inställningar"));
    var type = item.type === "movie" ? "movie" : "series";
    var url = BASE + "/" + configPath() + "/stream/" + type + "/" + encodeURIComponent(idFor(item)) + ".json";
    var maxRes = Settings.get("maxQuality") === "1080p" ? 1080 : 2160;
    return http(url, { timeout: 25000 }).then(function (r) {
      var list = ((r && r.streams) || []).filter(function (s) { return m === "rd" ? s.url : (s.url || s.infoHash); }).map(parse);
      list.forEach(function (s) { s.score = score(s, maxRes); });
      list.sort(function (a, b) { return b.score - a.score; });
      return list;
    });
  }

  // De bästa kandidaterna att prova automatiskt, i ordning
  function playable(list) {
    return list.filter(function (s) { return (s.cached || (s.p2p && s.seeders >= 5)) && !s.junk && !s.badAudio; });
  }

  return { fetchFor: fetchFor, playable: playable, idFor: idFor, mode: mode };
})();
