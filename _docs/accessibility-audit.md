# Responsive and accessibility verification

This record covers Issue #23. It verifies the existing visual direction rather than introducing a redesign. The responsive checks use the rendered component structure and Tailwind breakpoint contracts at the required CSS-pixel widths; semantic, state, input, and design-token checks are automated with Vitest and Testing Library.

## Responsive and zoom matrix

| View | 320 | 375 | 768 | 1280 | 200% zoom behavior |
|---|---|---|---|---|---|
| Home and guest entry | Pass | Pass | Pass | Pass | The single-column flow remains in normal document order; name, code, Create, and Join controls remain reachable. |
| Lobby | Pass | Pass | Pass | Pass | The two panels remain stacked below `lg`; roster controls wrap and the invite input uses a shrinkable field. |
| Role reveal and prompt selection/waiting | Pass | Pass | Pass | Pass | Prompt choices stack below `sm`; the custom prompt action stacks without clipping. |
| Artist canvas | Pass | Pass | Pass | Pass | The 4:3 canvas scales to its container and pointer coordinates map to the fixed logical canvas; tools wrap before the `lg` side-toolbar layout. |
| Judge Grid and Focus | Pass | Pass | Pass | Pass | Grid starts at one column and expands by roster size; Focus remains in normal flow beneath the sticky phase header and prompt banner. |
| Judging gallery | Pass | Pass | Pass | Pass | Cards use one column below `sm`; the rating field and slider remain available and Submit All stays visible in its sticky action area. |
| Round/final results | Pass | Pass | Pass | Pass | Result cards and leaderboard stack below `lg`; long player names truncate inside flexible rows rather than expanding the viewport. |
| Pause and interruption | Pass | Pass | Pass | Pass | The pause dialog uses inset padding and a bounded card; interruption actions remain in the centered normal-flow layout. |

No gameplay view introduces a fixed minimum page width. Horizontal scrolling is intentional only for the Focus View drawing switcher, where each anonymous thumbnail remains a reachable button. At 200% desktop zoom, responsive breakpoints fall back to the same tested stacked layouts, with phase, prompt, timer, rating, and submission controls still in document order.

## Keyboard, pointer, and assistive technology

- Buttons, links, inputs, sliders, and the anonymous drawing cards use native keyboard semantics. Shared controls have their component focus rings, and `styles.css` supplies a 3px visible fallback for every remaining native interactive control.
- Artist tools expose pressed state; palette targets are 28×28 CSS pixels and tool/action buttons are at least 32 pixels high. The rating slider thumb is 24×24. These meet the WCAG 2.2 24×24 minimum target or exceed it.
- Mouse and touch drawing use Pointer Events, pointer capture, `touch-action: none`, and responsive coordinate mapping. The Artist board tests exercise touch strokes after a responsive resize.
- Canvases with content names expose an image role and accessible label. Decorative Focus View thumbnails are hidden from the accessibility tree, leaving each switch button with one concise anonymous label.
- Lobby roster/connection changes, recovery notices, rating progress, role notices, waiting state, and canvas lock state use polite status semantics. Errors and overtime remain alerts. The second-by-second timer explicitly uses `aria-live="off"`.
- Selected tools, locked/live drawings, disconnected players, unrated cards, invalid ratings, and winners include text, semantic state, or icons in addition to color.
- The pause overlay is a named modal alert dialog. Its countdown is not a live region, avoiding a repeated announcement every second.

## Contrast and motion

Automated token checks convert the declared OKLCH colors to relative luminance. Representative normal-text contrast ratios are:

- ink on paper: 15.69:1
- ink on tomato primary: 4.71:1
- ink on mustard secondary: 11.29:1
- ink on teal accent: 6.83:1
- muted text on paper: 6.21:1
- light text on destructive: 4.66:1

The primary focus color is at least 3:1 against paper, and interactive controls retain the heavy ink border in every color state. With `prefers-reduced-motion: reduce`, nonessential animations are removed, transition duration is reduced to 0.01ms, and automatic smooth scrolling is disabled.

## Reproducible checks

- Focused audit: `npm test --workspace frontend -- --run src/test/accessibility-audit.test.ts src/components/game/ArtistBoard.test.tsx src/components/game/JudgeLiveView.test.tsx src/components/game/PhaseScreens.test.tsx`
- Full workspace: `npm test`
- Production build: `npm run build`

No accessibility exception remains for the Issue #23 acceptance criteria. Freehand drawing itself remains a pointer/touch interaction, as specified; every surrounding tool and submission action is keyboard operable.
