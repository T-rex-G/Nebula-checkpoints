/*
 * The page's small marks, drawn in the preset's own tones: what an empty list
 * shows above its words, and what sits beside a number or inside a small
 * control. Each is decoration and is hidden from assistive technology; the
 * words beside it carry the meaning.
 */
/*
 * The marks for a screen with nothing on it.
 *
 * Six empty states shared four Unicode glyphs between them -- a sparkle stood
 * for an unopened file, an untagged release and a workflow that has never run,
 * which tells a reader nothing about which screen they are on. Each one now
 * draws the thing it is the absence of.
 */
export const EMPTY_ICON: Readonly<Record<'file' | 'repos' | 'pulls' | 'issues' | 'releases' | 'actions', string>> = Object.freeze({
  file: '<svg class="empty-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z"/><path d="M13.5 3.5V8.5h5"/></svg>',
  repos: '<svg class="empty-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H19v16H6.5A1.5 1.5 0 0 1 5 18.5z"/><path d="M8.5 4v16"/></svg>',
  pulls: '<svg class="empty-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="6.5" r="2.3"/><circle cx="7" cy="17.5" r="2.3"/><circle cx="17" cy="12" r="2.3"/><path d="M7 8.8v6.4M9.3 6.5H13a1.7 1.7 0 0 1 1.7 1.7v2.1"/></svg>',
  issues: '<svg class="empty-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.2"/></svg>',
  releases: '<svg class="empty-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 3.5h8.5V12l-7.9 7.9a1.6 1.6 0 0 1-2.3 0l-5.2-5.2a1.6 1.6 0 0 1 0-2.3z"/><circle cx="15.6" cy="7.9" r="1.4"/></svg>',
  actions: '<svg class="empty-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M10.4 9.3l4.6 2.7-4.6 2.7z"/></svg>'
});

/*
 * Marks that sit beside a number or inside a small control.
 *
 * The last of the typed glyphs: a star, a fork, a speech bubble and a close
 * cross, all standing where the rest of the product draws. The fork also
 * appears in the branch <select>, and stays typed there -- a native option
 * element holds text and nothing else, so that one is a real constraint rather
 * than an oversight.
 */
export const META_ICON: Readonly<Record<'star' | 'fork' | 'comments' | 'close', string>> = Object.freeze({
  star: '<svg class="meta-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.8l2.6 5.2 5.8.9-4.2 4 1 5.7-5.2-2.7-5.2 2.7 1-5.7-4.2-4 5.8-.9z"/></svg>',
  fork: '<svg class="meta-mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="6.2" r="2.2"/><circle cx="17" cy="6.2" r="2.2"/><circle cx="12" cy="18" r="2.2"/><path d="M7 8.4v1.2a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3V8.4M12 12.6v3.2"/></svg>',
  comments: '<svg class="meta-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 12.2a6.8 6.8 0 0 1-6.8 6.8H8.9L4.6 21.4v-4.5a6.8 6.8 0 0 1 4.3-11.7h4.7a6.8 6.8 0 0 1 6.8 6.8z"/></svg>',
  close: '<svg class="ico" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
});
