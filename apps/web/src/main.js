/*
 * The browser application's one entry. The order of these imports is the
 * order the page used to list its scripts: each module still publishes what
 * the next one reads, until the interface is rebuilt from typed components.
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

import './legacy/vendor-globals.js';
import './features/workbench/archive-safety.js';
import './components/overlay-motion.js';
import './features/workbench/export-safety.js';
import './features/governance/governance-ui.js';
import './features/access/alpha-ui.js';
import './visualizations/vortex.js';
import './visualizations/landing-stage.js';
import './features/capabilities/capability-ui.js';
import './features/repositories/repo-sigil.js';
import './features/overview/workspace-pulse.js';
import './features/repositories/repo-inventory.js';
import './features/posture/security-posture.js';
import './features/posture/pull-board.js';
import './features/findings/findings-inbox-ui.js';
import './features/uranus/code-audit-ui.js';
import './features/parallax/rendered-audit-ui.js';
import './visualizations/nebula-visuals.js';
import './visualizations/landing-orbit.js';
import './visualizations/landing-map.js';
import './visualizations/light-waves.js';
import './features/trust/trust-ui.js';
import './legacy/app.js';
