/*
 * The browser application's one entry. Every module imports what it uses, so
 * nothing here is ordered for another module's sake, with one exception: the
 * probe comes first, because the harness marker it reads and deletes must be
 * gone before any other module of the page has run (ADR-092).
 */
import 'codemirror/lib/codemirror.css';
import 'codemirror/theme/material-ocean.css';
import 'codemirror/theme/dracula.css';
import 'codemirror/theme/monokai.css';
import 'codemirror/theme/nord.css';
import 'codemirror/theme/ayu-mirage.css';
import 'codemirror/theme/base16-light.css';
import 'codemirror/theme/eclipse.css';
import './styles/style.css';
import './styles/rendered-audit.css';

import './platform/probe.ts';
import './visualizations/landing-stage.js';
import './visualizations/landing-orbit.js';
import './visualizations/landing-map.js';
import './visualizations/light-waves.js';
import './legacy/app.js';
