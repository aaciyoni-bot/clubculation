// Shared data model (browser + server). State v2:
// { v:2, series:{ id:{name, created} }, pages:{ "<seriesId>/<page>": [serials] }, meta:{ "<seriesId>/<page>": {added, src} } }
(function (root) {
  function norm(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^0-9A-Zא-ת]/g, ''); }
  function empty() { return { v: 2, series: {}, pages: {}, meta: {} }; }
  function key(sid, p) { return sid + '/' + p; }
  function split(k) { var i = k.indexOf('/'); return { sid: k.slice(0, i), p: k.slice(i + 1) }; }
  function newId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  // v1 (flat pages keyed by page number) is dropped on purpose: the old lists were retired.
  function upgrade(state) {
    if (state && state.v === 2) { state.series = state.series || {}; state.pages = state.pages || {}; state.meta = state.meta || {}; return state; }
    return empty();
  }
  // change: {action:'save', seriesId?|seriesName?, page, serials, src} | {action:'delete', seriesId, page} | {action:'deleteSeries', seriesId}
  // returns {state, error?}
  function apply(state, change, today) {
    state = upgrade(JSON.parse(JSON.stringify(state || {})));
    var c = change || {};
    if (c.action === 'save') {
      var page = norm(c.page); if (!page) return { error: 'page' };
      var serials = (Array.isArray(c.serials) ? c.serials : []).map(norm).filter(Boolean);
      if (!serials.length) return { error: 'serials' };
      if (serials.length > 500) return { error: 'too_many' };
      var sid = c.seriesId && state.series[c.seriesId] ? c.seriesId : null;
      if (!sid) {
        var name = String(c.seriesName || '').trim().slice(0, 60);
        if (!name) return { error: 'series' };
        sid = newId();
        state.series[sid] = { name: name, created: today };
      }
      state.pages[key(sid, page)] = serials;
      state.meta[key(sid, page)] = { added: today, src: c.src === 'photo' ? 'photo' : 'manual' };
      return { state: state, seriesId: sid };
    }
    if (c.action === 'delete') {
      var k = key(String(c.seriesId || ''), norm(c.page));
      delete state.pages[k]; delete state.meta[k];
      return { state: state };
    }
    if (c.action === 'deleteSeries') {
      var sid2 = String(c.seriesId || '');
      Object.keys(state.pages).forEach(function (k2) { if (split(k2).sid === sid2) { delete state.pages[k2]; delete state.meta[k2]; } });
      delete state.series[sid2];
      return { state: state };
    }
    return { error: 'action' };
  }
  root.PagesModel = { norm: norm, empty: empty, key: key, split: split, upgrade: upgrade, apply: apply };
})(typeof module !== 'undefined' ? module.exports : window);
