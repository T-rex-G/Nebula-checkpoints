'use strict';

/*
 * The package names a typosquat imitates. A name one keystroke away from one
 * of these, or the same name with its separators moved, is how malicious
 * packages are found by the people who mistype them -- crossenv for
 * cross-env, electorn for electron, python3-dateutil for python-dateutil.
 *
 * Curated rather than fetched: the list changes slowly, the audit must not
 * depend on a download-count service being up, and a name only ever raises a
 * warning that asks the reader to check what they meant. Legitimate packages
 * that happen to sit one letter from a popular one are listed too, so they
 * are recognised as themselves rather than flagged.
 */

const NPM = Object.freeze([
  'react', 'react-dom', 'preact', 'next', 'vue', 'nuxt', 'svelte', 'angular', 'solid-js', 'astro', 'remix',
  'express', 'koa', 'fastify', 'hapi', 'nestjs', 'hono', 'restify', 'connect', 'body-parser', 'cookie-parser',
  'cors', 'helmet', 'morgan', 'compression', 'multer', 'busboy', 'formidable', 'express-session', 'passport',
  'passport-local', 'jsonwebtoken', 'jose', 'bcrypt', 'bcryptjs', 'argon2', 'crypto-js', 'uuid', 'nanoid',
  'lodash', 'lodash-es', 'underscore', 'ramda', 'immer', 'immutable', 'rxjs', 'zod', 'yup', 'joi', 'ajv',
  'axios', 'node-fetch', 'cross-fetch', 'isomorphic-fetch', 'got', 'superagent', 'request', 'undici', 'ky',
  'moment', 'dayjs', 'date-fns', 'luxon', 'chalk', 'colors', 'kleur', 'picocolors', 'ansi-styles', 'debug',
  'commander', 'yargs', 'minimist', 'inquirer', 'prompts', 'ora', 'dotenv', 'cross-env', 'cross-spawn',
  'execa', 'shelljs', 'rimraf', 'mkdirp', 'glob', 'fast-glob', 'globby', 'chokidar', 'fs-extra', 'graceful-fs',
  'semver', 'yaml', 'js-yaml', 'json5', 'ini', 'toml', 'xml2js', 'cheerio', 'jsdom', 'puppeteer', 'playwright',
  'webpack', 'webpack-cli', 'vite', 'rollup', 'esbuild', 'parcel', 'babel-loader', 'ts-loader', 'terser',
  'typescript', 'ts-node', 'tsx', 'eslint', 'prettier', 'stylelint', 'husky', 'lint-staged', 'nodemon', 'pm2',
  'jest', 'mocha', 'chai', 'sinon', 'vitest', 'ava', 'supertest', 'nock', 'cypress', 'karma', 'jasmine',
  'mongoose', 'mongodb', 'sequelize', 'typeorm', 'prisma', 'knex', 'pg', 'mysql', 'mysql2', 'sqlite3',
  'better-sqlite3', 'redis', 'ioredis', 'drizzle-orm', 'kysely', 'firebase', 'firebase-admin', 'socket.io',
  'socket.io-client', 'ws', 'graphql', 'apollo-server', 'stripe', 'twilio', 'nodemailer', 'sharp', 'jimp',
  'tailwindcss', 'postcss', 'autoprefixer', 'sass', 'less', 'styled-components', 'classnames', 'clsx',
  'redux', 'react-redux', 'zustand', 'jotai', 'recoil', 'mobx', 'swr', 'react-query', 'react-router',
  'react-router-dom', 'react-hook-form', 'formik', 'framer-motion', 'three', 'd3', 'chart.js', 'recharts',
  'electron', 'electron-builder', 'bluebird', 'async', 'q', 'core-js', 'regenerator-runtime', 'tslib',
  'qs', 'querystring', 'url', 'path-to-regexp', 'mime', 'mime-types', 'form-data', 'iconv-lite', 'buffer',
  'events', 'util', 'stream', 'process', 'bn.js', 'ethers', 'web3', 'openai', 'discord.js', 'telegraf',
  'marked', 'markdown-it', 'highlight.js', 'prismjs', 'dompurify', 'sanitize-html', 'xss', 'validator',
  'winston', 'pino', 'bunyan', 'log4js', 'loglevel', 'handlebars', 'ejs', 'pug', 'mustache', 'nunjucks',
  'eventemitter3', 'node-cron', 'cron', 'bull', 'bullmq', 'agenda', 'aws-sdk', 'googleapis', 'jquery',
  'bootstrap', 'serve', 'http-server', 'concurrently', 'npm-run-all', 'coffee-script', 'gulp', 'grunt',
  'browserify', 'babel-core', 'babel-preset-env', 'esm', 'source-map', 'source-map-support', 'object-assign',
  'is-number', 'kind-of', 'isarray', 'inherits', 'once', 'wrappy', 'ms', 'safe-buffer', 'string_decoder',
  'readable-stream', 'through2', 'pump', 'end-of-stream', 'deepmerge', 'deep-equal', 'fast-deep-equal',
  'escape-string-regexp', 'strip-ansi', 'ansi-regex', 'supports-color', 'has-flag', 'wrap-ansi', 'cliui',
  'string-width', 'emoji-regex', 'ignore', 'minimatch', 'micromatch', 'picomatch', 'braces', 'fill-range',
  'to-regex-range', 'resolve', 'enhanced-resolve', 'tapable', 'acorn', 'esprima', 'estraverse', 'espree',
  'postcss-loader', 'css-loader', 'style-loader', 'file-loader', 'url-loader', 'html-webpack-plugin',
  'mini-css-extract-plugin', 'copy-webpack-plugin', 'fork-ts-checker-webpack-plugin', 'node-sass', 'sass-loader',
  // Legitimate names one keystroke from a popular one, so they are not flagged.
  'reactor', 'nest', 'next-auth', 'nexe', 'nuxi', 'jsdoc', 'chalk-template', 'color', 'colord', 'yarn',
  'yargs-parser', 'globs', 'axios-retry', 'moment-timezone', 'uuidv4', 'redux-thunk', 'expresso', 'koa-router',
  'sqlite', 'ioredis-mock', 'jest-cli', 'vite-node', 'vitepress', 'esbuild-wasm', 'jwt-decode', 'dotenv-cli',
  'dotenv-expand', 'cross-env-shell'
]);

const PYPI = Object.freeze([
  'requests', 'urllib3', 'httpx', 'aiohttp', 'httplib2', 'certifi', 'charset-normalizer', 'idna', 'chardet',
  'numpy', 'pandas', 'scipy', 'matplotlib', 'seaborn', 'plotly', 'scikit-learn', 'sklearn', 'tensorflow',
  'torch', 'torchvision', 'keras', 'jax', 'transformers', 'datasets', 'tokenizers', 'sentencepiece',
  'openai', 'anthropic', 'langchain', 'llama-index', 'tiktoken', 'pydantic', 'pydantic-core', 'attrs',
  'django', 'djangorestframework', 'flask', 'fastapi', 'starlette', 'uvicorn', 'gunicorn', 'werkzeug', 'jinja2',
  'sqlalchemy', 'alembic', 'psycopg2', 'psycopg2-binary', 'psycopg', 'pymysql', 'mysqlclient', 'pymongo',
  'redis', 'celery', 'kombu', 'boto3', 'botocore', 's3transfer', 'awscli', 'google-cloud-storage',
  'google-api-python-client', 'azure-storage-blob', 'cryptography', 'pycryptodome', 'pyopenssl', 'bcrypt',
  'passlib', 'pyjwt', 'python-jose', 'itsdangerous', 'python-dotenv', 'pyyaml', 'toml', 'tomli', 'ujson',
  'orjson', 'simplejson', 'python-dateutil', 'pytz', 'tzdata', 'arrow', 'pendulum', 'six', 'setuptools',
  'wheel', 'pip', 'virtualenv', 'packaging', 'click', 'typer', 'rich', 'colorama', 'tqdm', 'loguru',
  'pytest', 'pytest-cov', 'coverage', 'tox', 'nose', 'mock', 'black', 'flake8', 'pylint', 'mypy', 'ruff',
  'isort', 'beautifulsoup4', 'bs4', 'lxml', 'html5lib', 'selenium', 'playwright', 'scrapy', 'pillow',
  'opencv-python', 'imageio', 'paramiko', 'fabric', 'docker', 'kubernetes', 'pexpect', 'psutil', 'grpcio',
  'protobuf', 'websockets', 'websocket-client', 'twisted', 'gevent', 'greenlet', 'eventlet', 'stripe',
  'twilio', 'sendgrid', 'slack-sdk', 'discord.py', 'python-telegram-bot', 'tweepy', 'markdown', 'pygments',
  'docutils', 'sphinx', 'jsonschema', 'marshmallow', 'wtforms', 'flask-login', 'flask-cors', 'flask-sqlalchemy',
  'streamlit', 'gradio', 'dash', 'bokeh', 'networkx', 'sympy', 'statsmodels', 'xgboost', 'lightgbm',
  'catboost', 'nltk', 'spacy', 'gensim', 'jupyter', 'notebook', 'ipython', 'ipykernel', 'supabase', 'firebase-admin',
  // Legitimate near-names.
  'requests-oauthlib', 'requests-toolbelt', 'httpcore', 'flask-limiter', 'tomlkit', 'pyaml', 'jwt', 'jose',
  'pytest-mock', 'numba', 'pandas-stubs'
]);

module.exports = Object.freeze({ NPM, PYPI });
