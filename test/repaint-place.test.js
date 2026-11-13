'use strict';

/*
 * How a card drawn through repaintCard keeps the reader's place, asked of
 * the module over a page laid out here: cards stacked and side by side,
 * a region that scrolls or a page under a bar fixed across its top, and a
 * draw that grows a card and moves what is below it. The browser suite reads
 * the same on the Overview itself (test/e2e/overview-place.spec.js); this
 * reaches the layouts the Overview's readings do not make, a card that grows
 * past the card beside it in a row among them.
 */
const assert = require('node:assert/strict');
const { loadPageModule } = require('./helpers/page-module');

/* A page: boxes with a top and a height in the page, a scroller, and what each draw does to them. */
function makePage({ pageScrolls = false, bar = 0 } = {}) {
  const nodes = new Map();
  let scroll = 0;
  const scroller = {
    id: 'region', parentElement: null, children: [],
    get scrollTop() { return scroll; },
    set scrollTop(value) { scroll = value; },
    get scrollHeight() { return 10000; },
    get clientHeight() { return 600; },
    getBoundingClientRect: () => ({ top: pageScrolls ? 0 : 100, bottom: pageScrolls ? 700 : 700, height: 600 })
  };
  const style = new Map([[scroller, { overflowY: pageScrolls ? 'visible' : 'auto', position: 'static' }]]);
  const page = { id: 'page', className: 'page', parentElement: null, children: [] };
  const topbar = {
    id: 'bar', className: 'topbar', children: [], parentElement: page,
    getBoundingClientRect: () => ({ top: 0, bottom: bar, height: bar })
  };
  style.set(topbar, { overflowY: 'visible', position: 'fixed' });
  page.querySelector = selector => (selector === '.topbar' && bar ? topbar : null);
  scroller.parentElement = page;
  const offset = () => (pageScrolls ? 0 : 100) - scroll;
  const node = (id, parent, top, height) => {
    const element = {
      id, top, height, parentElement: parent, children: [], isConnected: true,
      get nextElementSibling() {
        const siblings = this.parentElement ? this.parentElement.children : [];
        return siblings[siblings.indexOf(this) + 1] || null;
      },
      getBoundingClientRect() {
        const at = this.top + offset();
        return { top: at, bottom: at + this.height, height: this.height };
      },
      closest(selector) {
        for (let n = this; n; n = n.parentElement) if (selector === '.page' && n === page) return n;
        return null;
      }
    };
    parent.children.push(element);
    style.set(element, { overflowY: 'visible', position: 'static' });
    nodes.set(id, element);
    return element;
  };
  /* The module, run over this page: its computed styles and its document, and no window, so nothing is ever pressed. */
  const { repaintCard } = loadPageModule('apps/web/src/components/held-repaint.ts', {
    getComputedStyle: element => style.get(element) || { overflowY: 'visible', position: 'static' },
    document: { scrollingElement: pageScrolls ? scroller : null, documentElement: scroller }
  });
  const parentOf = pageScrolls ? page : scroller;
  /*
   * The page: a row of two cards side by side (trust on the left, a column of
   * two on the right), the posture below the row, then the feed and the board.
   */
  const row = node('row', parentOf, 0, 600);
  const trust = node('trust', row, 0, 600);
  const column = node('column', row, 0, 500);
  const signals = node('signals', column, 0, 280);
  const activity = node('activity', column, 300, 200);
  const posture = node('posture', parentOf, 620, 90);
  const feed = node('feed', parentOf, 730, 360);
  const board = node('board', parentOf, 1110, 90);
  /* Grows `card` by `by`, and moves everything laid out below the row or the card by however far the row or the card grew. */
  const grow = (card, by) => {
    const rowBefore = row.height;
    card.height += by;
    if (card === activity) column.height = Math.max(column.height, activity.top + activity.height);
    row.height = Math.max(trust.height, column.height);
    const rowGrew = row.height - rowBefore;
    const shift = card === trust || card === activity ? rowGrew : by;
    for (const below of [posture, feed, board]) if (below.top > card.top) below.top += shift;
  };
  return { repaintCard, scroller, nodes, grow, scrollBy: value => { scroll += value; }, get scroll() { return scroll; }, feedTop: () => feed.getBoundingClientRect().top };
}

{

  /* A card the reader has scrolled past: what follows it stays where the reader has it. */
  {
    const page = makePage();
    page.scrollBy(700);
    const before = page.feedTop();
    page.repaintCard(page.nodes.get('posture'), () => page.grow(page.nodes.get('posture'), 850));
    assert.equal(page.feedTop(), before, 'the feed stays under the reader');
    assert.equal(page.scroll, 1550, 'the view moved by however far the card grew');
  }
  /* A card in view fills in where it stands. */
  {
    const page = makePage();
    page.scrollBy(500);
    const card = page.nodes.get('posture');
    const before = card.getBoundingClientRect().top;
    page.repaintCard(card, () => page.grow(card, 850));
    assert.equal(card.getBoundingClientRect().top, before, 'the card stays where the reader sees it');
    assert.equal(page.scroll, 500, 'and the view does not move');
  }
  /* A card that begins above the view but runs into it keeps what follows it in place too. */
  {
    const page = makePage();
    page.scrollBy(650);
    const before = page.feedTop();
    page.repaintCard(page.nodes.get('posture'), () => page.grow(page.nodes.get('posture'), 400));
    assert.equal(page.feedTop(), before);
  }
  /*
   * A card in a row grows past the card beside it: what follows it is the
   * posture below the row, not the column beside it, which does not move.
   */
  {
    const page = makePage();
    page.scrollBy(900);
    const before = page.feedTop();
    page.repaintCard(page.nodes.get('trust'), () => page.grow(page.nodes.get('trust'), 120));
    assert.equal(page.feedTop(), before, 'the row grew by 120 px and the feed below it stays');
    assert.equal(page.scroll, 1020);
  }
  /* A card whose body grows by more than its row does: the row's growth is what moves the reader. */
  {
    const page = makePage();
    page.scrollBy(900);
    const before = page.feedTop();
    page.repaintCard(page.nodes.get('activity'), () => page.grow(page.nodes.get('activity'), 203));
    assert.equal(page.feedTop(), before, 'the activity grew 203 px, its row 103, and the feed stays');
    assert.equal(page.scroll, 1003);
  }
  /* A drawn card nothing follows moves nothing. */
  {
    const page = makePage();
    page.scrollBy(1200);
    page.repaintCard(page.nodes.get('board'), () => page.grow(page.nodes.get('board'), 600));
    assert.equal(page.scroll, 1200);
  }
  /* On a phone the page scrolls under a fixed bar: a card that begins under the bar has begun above the view. */
  {
    const page = makePage({ pageScrolls: true, bar: 68 });
    page.scrollBy(580);
    const card = page.nodes.get('posture');
    assert.ok(card.getBoundingClientRect().top > 0 && card.getBoundingClientRect().top < 68, 'the card begins under the bar, on the screen');
    const before = page.feedTop();
    page.repaintCard(card, () => page.grow(card, 850));
    assert.equal(page.feedTop(), before, 'the feed stays under the reader');
  }
  {
    const page = makePage({ pageScrolls: true, bar: 68 });
    page.scrollBy(500);
    const card = page.nodes.get('posture');
    const before = card.getBoundingClientRect().top;
    assert.ok(before > 68, 'the card begins below the bar');
    page.repaintCard(card, () => page.grow(card, 850));
    assert.equal(card.getBoundingClientRect().top, before, 'a card in view on a phone fills in where it stands');
  }
  /* A card the draw takes off the page keeps nothing. */
  {
    const page = makePage();
    page.scrollBy(700);
    const card = page.nodes.get('posture');
    page.repaintCard(card, () => { page.nodes.get('feed').isConnected = false; page.grow(card, 850); });
    assert.equal(page.scroll, 700, 'a follower no longer on the page is not measured');
  }
  console.log('repaint place tests passed');
}
