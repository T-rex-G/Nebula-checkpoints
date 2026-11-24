'use strict';

/*
 * The ink on one of the page's canvases: its summed alpha, over the whole
 * canvas or a rectangle of it in canvas pixels, every `stride`th pixel.
 *
 * The canvas is copied into one the check owns, and the copy is read. Reading
 * the page's own canvas with getImageData changes that canvas: on its second
 * readback Chromium moves a GPU canvas to the CPU, rebuilding its backing from
 * a snapshot inside that very call -- and such a readback has come back with
 * the first one's pixels while the canvas went on drawing on screen. A copy
 * leaves the page's canvas as the reader has it and reads the same each time.
 * A rectangle running past the canvas reads the part outside as empty, as
 * getImageData would.
 */
function canvasInk(page, selector, { x = 0, y = 0, w = null, h = null, stride = 1 } = {}) {
  return page.evaluate(({ selector, x, y, w, h, stride }) => {
    const canvas = document.querySelector(selector);
    const width = w ?? canvas.width - x;
    const height = h ?? canvas.height - y;
    const copy = document.createElement('canvas');
    copy.width = width;
    copy.height = height;
    const ctx = copy.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, x, y, width, height, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;
    let sum = 0;
    for (let i = 3; i < data.length; i += 4 * stride) sum += data[i];
    return sum;
  }, { selector, x, y, w, h, stride });
}

module.exports = { canvasInk };
