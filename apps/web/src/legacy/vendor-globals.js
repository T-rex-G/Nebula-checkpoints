/*
 * The pinned browser libraries, bundled from their npm packages rather than
 * copied into the repository, and published under the names the classic
 * interface code still reads. Imported before anything else so they exist
 * when that code first runs. Transitional: each consumer imports the library
 * directly once it is a typed module.
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
import { marked } from 'marked';
import DOMPurify from 'dompurify';

Object.assign(globalThis, { CodeMirror, marked, DOMPurify });
