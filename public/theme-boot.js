/* The theme, before the first paint and before the gate. */
'use strict';

/*
 * Restoring the stored theme lived in app.js's loadSettings(), which runs
 * from boot() -- and boot() runs only once the access gate has granted. So
 * every visitor met the landing page in dark whatever they had chosen, and
 * toggling it there did not survive a reload: the choice was written and
 * never read back.
 *
 * This runs from <head> instead, so the document is never painted in the
 * wrong theme and the gate is treated as what it is: a screen of this product
 * like any other.
 *
 * A file rather than an inline block because script-src is 'self' with no
 * 'unsafe-inline' -- an inline script here would be refused and silently do
 * nothing, which is the worst of both.
 */
(function themeBoot() {
  var root = document.documentElement;
  var stored = null;
  try { stored = localStorage.getItem('nv_theme'); } catch (e) { stored = null; }
  if (stored === 'dark' || stored === 'light') root.dataset.theme = stored;

  // The access gate appears before app.js restores Settings. Motion is a
  // product-wide choice too, including the landing video and CSS entrances.
  try {
    var settings = JSON.parse(localStorage.getItem('nv_settings'));
    if (settings && typeof settings.motion === 'boolean') {
      root.dataset.motion = settings.motion ? 'on' : 'off';
    }
  } catch (e) { /* Missing, malformed or blocked storage keeps the defaults. */ }

  var meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = root.dataset.theme === 'light' ? '#F4F2EE' : '#07080A';

  /*
   * The switches report the theme they are actually in. They are markup, so
   * they do not exist yet at <head> time; and without this a reader who had
   * chosen light met a control telling a screen reader it was dark until they
   * pressed it once. Click-time syncing is toggleTheme's job, not this one's.
   */
  document.addEventListener('DOMContentLoaded', function syncSwitches() {
    var on = String(root.dataset.theme === 'dark');
    var list = document.querySelectorAll('.theme-toggle');
    for (var i = 0; i < list.length; i++) list[i].setAttribute('aria-checked', on);
  });
})();
