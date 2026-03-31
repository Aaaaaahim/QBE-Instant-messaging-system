(function () {
  'use strict';

  function ensureOcean() {
    try {
      var raw = localStorage.getItem('qbe.ui.settings');
      var settings = raw ? JSON.parse(raw) : null;
      if (!settings || !settings.bg_motion) return;
    } catch (_) { return; }
    if (document.getElementById('qbe-ocean')) return;
    var el = document.createElement('div');
    el.id = 'qbe-ocean';

    // Decorative layers (kept minimal for performance)
    var band = document.createElement('div');
    band.className = 'qbe-ocean-band';

    var b1 = document.createElement('div');
    b1.className = 'qbe-ocean-bubbles qbe-b1';

    var b2 = document.createElement('div');
    b2.className = 'qbe-ocean-bubbles qbe-b2';

    el.appendChild(band);
    el.appendChild(b1);
    el.appendChild(b2);
    // Insert as the first element in body so page content stays above.
    try {
      document.body.insertBefore(el, document.body.firstChild);
    } catch (_) {
      try { document.body.appendChild(el); } catch (_) {}
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureOcean);
  } else {
    ensureOcean();
  }
})();
