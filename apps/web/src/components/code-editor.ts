/*
 * The editor library, with the modes and the search addon the workbench
 * uses registered on it. A mode registers itself on CodeMirror when its
 * module is evaluated, so importing the editor from here is what guarantees
 * that every language the workbench names is known before the first file
 * opens.
 */
import CodeMirror from 'codemirror';
import 'codemirror/mode/meta.js';
import 'codemirror/mode/javascript/javascript.js';
import 'codemirror/mode/xml/xml.js';
import 'codemirror/mode/css/css.js';
import 'codemirror/mode/htmlmixed/htmlmixed.js';
import 'codemirror/mode/markdown/markdown.js';
import 'codemirror/mode/python/python.js';
import 'codemirror/mode/shell/shell.js';
import 'codemirror/mode/yaml/yaml.js';
import 'codemirror/addon/search/searchcursor.js';

export default CodeMirror;
